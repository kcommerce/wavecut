/**
 * app.js
 * ──────────────────────────────────────────────────────────
 * WaveCut MP3 Editor — Main Application
 *
 * Architecture:
 *  - State: one plain object updated immutably
 *  - AudioContext: shared, resumed on first user gesture
 *  - Waveform: drawn on <canvas>, zoom/scroll managed here
 *  - Playback: AudioBufferSourceNode (recreated on each play)
 *  - Selection: pixel → time mapping via zoom/scroll state
 * ──────────────────────────────────────────────────────────
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════ */

const state = {
  // Audio data
  audioCtx:      null,     // AudioContext
  sourceBuffer:  null,     // Current AudioBuffer (the "master" copy)
  gainNode:      null,     // GainNode for volume
  sourceNode:    null,     // Currently playing AudioBufferSourceNode

  // File info
  fileName:      '',
  fileSize:      0,

  // Playback
  isPlaying:     false,
  playStartTime: 0,        // AudioContext time when play started
  playOffset:    0,        // Buffer offset in seconds when play started
  currentTime:   0,        // Current playback position in seconds
  speed:         1.0,
  volume:        1.0,
  loopMode:      false,

  // Waveform / viewport
  zoomLevel:     1.0,      // 1× = full view; higher = zoomed in
  scrollOffset:  0.0,      // Scroll position in seconds (leftmost visible time)
  waveformPeaks: null,     // Float32Array of peak data
  canvasWidth:   0,
  canvasHeight:  0,

  // Selection
  selStart:      null,     // Selection start in seconds (null = no selection)
  selEnd:        null,     // Selection end in seconds
  isDragging:    false,
  dragStartX:    0,

  // Markers (split points)
  markers:       [],       // Array of times in seconds

  // Undo stack (stores previous AudioBuffers)
  undoStack:     [],

  // Segments (result of split)
  segments:      [],
};

/* ══════════════════════════════════════════════════════════
   DOM REFS
   ══════════════════════════════════════════════════════════ */

const $  = (id) => document.getElementById(id);
const el = {
  dropZone:        $('dropZone'),
  fileInput:       $('fileInput'),
  btnUpload:       $('btnUpload'),
  editorContainer: $('editorContainer'),
  fileInfo:        $('fileInfo'),
  infoName:        $('infoName'),
  infoDuration:    $('infoDuration'),
  infoSize:        $('infoSize'),

  waveformWrapper: $('waveformWrapper'),
  waveformCanvas:  $('waveformCanvas'),
  playhead:        $('playhead'),
  selectionOverlay:$('selectionOverlay'),
  markerLayer:     $('markerLayer'),
  timeRuler:       $('timeRuler'),
  scrollTrack:     $('scrollTrack'),
  scrollThumb:     $('scrollThumb'),

  btnZoomIn:       $('btnZoomIn'),
  btnZoomOut:      $('btnZoomOut'),
  zoomLabel:       $('zoomLabel'),
  selStart:        $('selStart'),
  selEnd:          $('selEnd'),
  selDuration:     $('selDuration'),
  btnSelectAll:    $('btnSelectAll'),
  btnClearSel:     $('btnClearSel'),

  currentTime:     $('currentTime'),
  totalTime:       $('totalTime'),
  btnPlay:         $('btnPlay'),
  btnStop:         $('btnStop'),
  btnLoop:         $('btnLoop'),
  speedSlider:     $('speedSlider'),
  speedLabel:      $('speedLabel'),
  volumeSlider:    $('volumeSlider'),
  volumeLabel:     $('volumeLabel'),

  btnTrim:         $('btnTrim'),
  btnDelete:       $('btnDelete'),
  btnAddMarker:    $('btnAddMarker'),
  btnClearMarkers: $('btnClearMarkers'),
  btnSplit:        $('btnSplit'),
  btnUndo:         $('btnUndo'),
  btnExport:       $('btnExport'),

  segmentsPanel:   $('segmentsPanel'),
  segmentsList:    $('segmentsList'),
  btnExportAll:    $('btnExportAll'),

  exportModal:     $('exportModal'),
  exportName:      $('exportName'),
  fmtMp3:         $('fmtMp3'),
  scopeSelection:  $('scopeSelection'),
  btnCancelExport: $('btnCancelExport'),
  btnConfirmExport:$('btnConfirmExport'),

  toast:           $('toast'),
  progressOverlay: $('progressOverlay'),
  progressLabel:   $('progressLabel'),
  progressBarFill: $('progressBarFill'),
};

/* ══════════════════════════════════════════════════════════
   AUDIO CONTEXT
   ══════════════════════════════════════════════════════════ */

function getAudioContext() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.gainNode = state.audioCtx.createGain();
    state.gainNode.connect(state.audioCtx.destination);
  }
  // Resume if suspended (browser autoplay policy)
  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
  return state.audioCtx;
}

/* ══════════════════════════════════════════════════════════
   FILE LOADING
   ══════════════════════════════════════════════════════════ */

async function loadFile(file) {
  // Validate type
  const validTypes = ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/ogg',
                      'audio/mp4', 'audio/aac', 'audio/x-m4a'];
  if (!file.type.startsWith('audio/') && !validTypes.includes(file.type)) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3','wav','ogg','m4a','aac','flac','opus'].includes(ext)) {
      showToast('Unsupported file format', 'error');
      return;
    }
  }

  // Warn on large files
  const MB = file.size / (1024 * 1024);
  const isMobile = /Mobi|Android/i.test(navigator.userAgent);
  if ((isMobile && MB > 20) || MB > 50) {
    showToast(`Large file (${MB.toFixed(1)} MB) — may be slow`, 'info');
  }

  showProgress('Decoding audio…', 0);

  try {
    const ctx = getAudioContext();

    // Read file as ArrayBuffer
    const arrayBuffer = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload  = e => res(e.target.result);
      reader.onerror = () => rej(new Error('File read failed'));
      reader.readAsArrayBuffer(file);
    });

    updateProgress(0.3, 'Decoding PCM…');

    // Decode using Web Audio API → AudioBuffer
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    updateProgress(0.7, 'Building waveform…');

    // Store state
    state.sourceBuffer = audioBuffer;
    state.fileName     = file.name.replace(/\.[^.]+$/, ''); // strip extension
    state.fileSize     = file.size;
    state.undoStack    = [];
    state.markers      = [];
    state.segments     = [];
    state.selStart     = null;
    state.selEnd       = null;
    state.zoomLevel    = 1.0;
    state.scrollOffset = 0;

    stopPlayback();

    // Generate waveform peaks (use canvas width or default 2000px)
    const peakCount = Math.min(Math.max(el.waveformWrapper.clientWidth * 2, 800), 4000);
    state.waveformPeaks = extractWaveformPeaks(audioBuffer, peakCount);

    updateProgress(0.95, 'Rendering…');

    // Update header info
    el.infoName.textContent     = file.name;
    el.infoDuration.textContent = formatTime(audioBuffer.duration);
    el.infoSize.textContent     = formatSize(file.size);
    el.totalTime.textContent    = formatTime(audioBuffer.duration);
    el.fileInfo.style.display   = 'flex';

    // Show editor, hide drop zone
    el.dropZone.style.display        = 'none';
    el.editorContainer.style.display = 'flex';

    // Force canvas resize then draw
    resizeCanvas();
    drawWaveform();
    updateScrollThumb();

    hideProgress();
    showToast('Audio loaded successfully', 'success');

  } catch (err) {
    hideProgress();
    console.error('[loadFile]', err);
    showToast('Failed to decode audio: ' + err.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════
   WAVEFORM RENDERING
   ══════════════════════════════════════════════════════════ */

function resizeCanvas() {
  const wrapper = el.waveformWrapper;
  const dpr     = window.devicePixelRatio || 1;
  const w       = wrapper.clientWidth;
  const h       = wrapper.clientHeight;

  el.waveformCanvas.width  = w * dpr;
  el.waveformCanvas.height = h * dpr;
  el.waveformCanvas.style.width  = w + 'px';
  el.waveformCanvas.style.height = h + 'px';

  state.canvasWidth  = w;
  state.canvasHeight = h;
}

/**
 * Draw the waveform on canvas.
 * Respects zoom level and scroll offset.
 */
function drawWaveform() {
  if (!state.sourceBuffer || !state.waveformPeaks) return;

  const canvas  = el.waveformCanvas;
  const ctx2d   = canvas.getContext('2d');
  const dpr     = window.devicePixelRatio || 1;
  const W       = canvas.width;    // physical pixels
  const H       = canvas.height;
  const w       = W / dpr;         // CSS pixels
  const h       = H / dpr;

  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clear
  ctx2d.clearRect(0, 0, w, h);

  // Background
  ctx2d.fillStyle = '#0d0f12';
  ctx2d.fillRect(0, 0, w, h);

  const duration    = state.sourceBuffer.duration;
  const visibleDur  = duration / state.zoomLevel;   // seconds visible
  const scrollSec   = state.scrollOffset;           // leftmost time
  const endSec      = scrollSec + visibleDur;

  // Which peak indices are visible?
  const peakTotal  = state.waveformPeaks.length / 2;
  const peakStart  = Math.floor((scrollSec / duration) * peakTotal);
  const peakEnd    = Math.ceil ((endSec   / duration) * peakTotal);
  const peakCount  = Math.max(1, peakEnd - peakStart);

  // Mid-line
  const midY = h / 2;

  // Draw center line
  ctx2d.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx2d.lineWidth   = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, midY);
  ctx2d.lineTo(w, midY);
  ctx2d.stroke();

  // Draw waveform bars
  const peaks = state.waveformPeaks;
  const barW   = w / peakCount;

  for (let i = 0; i < peakCount; i++) {
    const pi  = (peakStart + i) * 2;
    if (pi + 1 >= peaks.length) break;

    const minV = peaks[pi];
    const maxV = peaks[pi + 1];

    const x = i * barW;
    const yTop    = midY - maxV * midY * 0.95;
    const yBottom = midY - minV * midY * 0.95;
    const barH    = Math.max(1, yBottom - yTop);

    // Color by intensity
    const intensity = Math.abs(maxV - minV);
    const alpha = 0.5 + intensity * 0.5;

    // Gradient bar color: cyan tones
    const gradient = ctx2d.createLinearGradient(0, yTop, 0, yBottom);
    gradient.addColorStop(0,   `rgba(0, 229, 204, ${alpha * 0.9})`);
    gradient.addColorStop(0.5, `rgba(0, 180, 160, ${alpha})`);
    gradient.addColorStop(1,   `rgba(0, 229, 204, ${alpha * 0.9})`);

    ctx2d.fillStyle = gradient;
    ctx2d.fillRect(x, yTop, Math.max(barW - 0.5, 0.5), barH);
  }

  // Draw selection overlay (canvas layer for visual only — CSS handles the div)
  // Update the CSS selection overlay div
  updateSelectionOverlay();
  updatePlayheadPosition();
  updateTimeRuler();
}

/* ══════════════════════════════════════════════════════════
   SELECTION OVERLAY
   ══════════════════════════════════════════════════════════ */

function updateSelectionOverlay() {
  const overlay = el.selectionOverlay;

  if (state.selStart === null || state.selEnd === null ||
      Math.abs(state.selEnd - state.selStart) < 0.001) {
    overlay.style.display = 'none';
    el.selStart.textContent = '—';
    el.selEnd.textContent   = '—';
    el.selDuration.textContent = '';
    return;
  }

  const s = Math.min(state.selStart, state.selEnd);
  const e = Math.max(state.selStart, state.selEnd);

  const x1 = timeToPx(s);
  const x2 = timeToPx(e);

  overlay.style.display = 'block';
  overlay.style.left    = x1 + 'px';
  overlay.style.width   = Math.max(0, x2 - x1) + 'px';

  el.selStart.textContent    = formatTime(s, true);
  el.selEnd.textContent      = formatTime(e, true);
  el.selDuration.textContent = '(' + formatTime(e - s, true) + ')';
}

function updatePlayheadPosition() {
  const px = timeToPx(state.currentTime);
  el.playhead.style.left = px + 'px';
}

/* ══════════════════════════════════════════════════════════
   TIME RULER
   ══════════════════════════════════════════════════════════ */

function updateTimeRuler() {
  if (!state.sourceBuffer) return;

  const ruler     = el.timeRuler;
  const duration  = state.sourceBuffer.duration;
  const visibleDur= duration / state.zoomLevel;
  const w         = state.canvasWidth;

  ruler.innerHTML = '';

  // Choose tick interval based on visible duration
  let interval = 1;
  const tickIntervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const t of tickIntervals) {
    if (visibleDur / t < 20) { interval = t; break; }
  }

  const startSec = state.scrollOffset;
  const endSec   = startSec + visibleDur;

  // First tick at or after startSec
  const firstTick = Math.ceil(startSec / interval) * interval;

  for (let t = firstTick; t <= endSec + interval; t += interval) {
    const px = timeToPx(t);
    if (px < -50 || px > w + 50) continue;

    const tick = document.createElement('span');
    tick.className = 'ruler-tick';
    tick.style.cssText = `
      position: absolute;
      left: ${px}px;
      top: 4px;
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--text-muted);
      white-space: nowrap;
      transform: translateX(-50%);
      pointer-events: none;
    `;
    tick.textContent = formatTime(t);

    // Draw a tiny tick mark
    const line = document.createElement('div');
    line.style.cssText = `
      position: absolute;
      left: ${px}px;
      top: 0;
      width: 1px;
      height: 4px;
      background: var(--border-bright);
    `;
    ruler.appendChild(line);
    ruler.appendChild(tick);
  }
}

/* ══════════════════════════════════════════════════════════
   COORDINATE CONVERSION
   ══════════════════════════════════════════════════════════ */

/** Convert time in seconds → canvas X pixel */
function timeToPx(timeSec) {
  if (!state.sourceBuffer) return 0;
  const duration   = state.sourceBuffer.duration;
  const visibleDur = duration / state.zoomLevel;
  return ((timeSec - state.scrollOffset) / visibleDur) * state.canvasWidth;
}

/** Convert canvas X pixel → time in seconds */
function pxToTime(px) {
  if (!state.sourceBuffer) return 0;
  const duration   = state.sourceBuffer.duration;
  const visibleDur = duration / state.zoomLevel;
  const t = state.scrollOffset + (px / state.canvasWidth) * visibleDur;
  return Math.max(0, Math.min(duration, t));
}

/* ══════════════════════════════════════════════════════════
   ZOOM
   ══════════════════════════════════════════════════════════ */

function setZoom(newZoom) {
  if (!state.sourceBuffer) return;
  const duration   = state.sourceBuffer.duration;
  const oldZoom    = state.zoomLevel;
  const newClamped = Math.max(1, Math.min(50, newZoom));

  // Keep center time fixed during zoom
  const centerTime = state.scrollOffset + (duration / oldZoom) / 2;
  const newVisible = duration / newClamped;
  let   newScroll  = centerTime - newVisible / 2;
  newScroll = Math.max(0, Math.min(duration - newVisible, newScroll));

  state.zoomLevel    = newClamped;
  state.scrollOffset = newScroll;

  el.zoomLabel.textContent = newClamped.toFixed(1).replace('.0', '') + '×';

  drawWaveform();
  updateScrollThumb();
}

/* ══════════════════════════════════════════════════════════
   SCROLL
   ══════════════════════════════════════════════════════════ */

function scrollTo(sec) {
  if (!state.sourceBuffer) return;
  const duration   = state.sourceBuffer.duration;
  const visibleDur = duration / state.zoomLevel;
  state.scrollOffset = Math.max(0, Math.min(duration - visibleDur, sec));
  drawWaveform();
  updateScrollThumb();
}

function updateScrollThumb() {
  if (!state.sourceBuffer) return;
  const duration   = state.sourceBuffer.duration;
  const visibleDur = duration / state.zoomLevel;
  const trackW     = el.scrollTrack.clientWidth;

  const thumbW  = Math.max(20, (visibleDur / duration) * trackW);
  const thumbL  = (state.scrollOffset / duration) * trackW;

  el.scrollThumb.style.width = thumbW + 'px';
  el.scrollThumb.style.left  = thumbL + 'px';
}

/* ══════════════════════════════════════════════════════════
   PLAYBACK
   ══════════════════════════════════════════════════════════ */

function startPlayback(fromTime) {
  const ctx    = getAudioContext();
  const buffer = state.sourceBuffer;
  if (!buffer) return;

  stopPlayback(false);

  const startSec = (fromTime !== undefined) ? fromTime : state.currentTime;

  // Determine play range
  let playStart = startSec;
  let playEnd   = buffer.duration;

  if (state.loopMode && state.selStart !== null) {
    const s = Math.min(state.selStart, state.selEnd);
    const e = Math.max(state.selStart, state.selEnd);
    playStart = Math.max(startSec, s);
    playEnd   = e;
  }

  const offset   = Math.max(0, Math.min(playStart, buffer.duration - 0.001));
  const duration = playEnd - offset;

  if (duration < 0.01) {
    // At end — go back to start
    state.currentTime = (state.loopMode && state.selStart !== null)
      ? Math.min(state.selStart, state.selEnd)
      : 0;
    updatePlayheadPosition();
    return;
  }

  const source        = ctx.createBufferSource();
  source.buffer       = buffer;
  source.playbackRate.value = state.speed;
  source.connect(state.gainNode);

  source.onended = () => {
    if (state.isPlaying) {
      if (state.loopMode && state.selStart !== null) {
        // Loop back to selection start
        const s = Math.min(state.selStart, state.selEnd);
        state.currentTime = s;
        startPlayback(s);
      } else {
        state.isPlaying = false;
        el.btnPlay.textContent = '▶';
        cancelAnimationFrame(state._rafId);
      }
    }
  };

  source.start(0, offset, duration);

  state.sourceNode    = source;
  state.playStartTime = ctx.currentTime;
  state.playOffset    = offset;
  state.isPlaying     = true;

  el.btnPlay.textContent = '⏸';
  schedulePlayheadUpdate();
}

function stopPlayback(resetTime = true) {
  if (state.sourceNode) {
    try { state.sourceNode.stop(); } catch (_) {}
    state.sourceNode = null;
  }
  state.isPlaying = false;
  el.btnPlay.textContent = '▶';
  cancelAnimationFrame(state._rafId);

  if (resetTime) {
    state.currentTime = 0;
    el.currentTime.textContent = formatTime(0, true);
    updatePlayheadPosition();
  }
}

function pausePlayback() {
  if (!state.isPlaying) return;
  // Capture current time before stopping
  state.currentTime = getCurrentPlaybackTime();
  if (state.sourceNode) {
    try { state.sourceNode.stop(); } catch (_) {}
    state.sourceNode = null;
  }
  state.isPlaying = false;
  el.btnPlay.textContent = '▶';
  cancelAnimationFrame(state._rafId);
}

function getCurrentPlaybackTime() {
  if (!state.isPlaying || !state.audioCtx) return state.currentTime;
  const elapsed = (state.audioCtx.currentTime - state.playStartTime) * state.speed;
  return Math.min(state.playOffset + elapsed, state.sourceBuffer?.duration || 0);
}

function schedulePlayheadUpdate() {
  const tick = () => {
    if (!state.isPlaying) return;

    const t = getCurrentPlaybackTime();
    state.currentTime = t;

    el.currentTime.textContent = formatTime(t, true);
    updatePlayheadPosition();

    // Auto-scroll to follow playhead
    if (state.sourceBuffer) {
      const duration   = state.sourceBuffer.duration;
      const visibleDur = duration / state.zoomLevel;
      const margin     = visibleDur * 0.1;
      if (t > state.scrollOffset + visibleDur - margin) {
        scrollTo(t - margin);
      }
    }

    state._rafId = requestAnimationFrame(tick);
  };
  state._rafId = requestAnimationFrame(tick);
}

/* ══════════════════════════════════════════════════════════
   EDITING OPERATIONS
   ══════════════════════════════════════════════════════════ */

function pushUndo() {
  state.undoStack.push(state.sourceBuffer);
  if (state.undoStack.length > 20) state.undoStack.shift();
}

function getSelectionRange() {
  if (state.selStart === null) return null;
  return {
    start: Math.min(state.selStart, state.selEnd),
    end:   Math.max(state.selStart, state.selEnd),
  };
}

function doTrim() {
  const sel = getSelectionRange();
  if (!sel) { showToast('Select a region first', 'error'); return; }

  const ctx = getAudioContext();
  stopPlayback();
  pushUndo();

  try {
    state.sourceBuffer = trimBuffer(ctx, state.sourceBuffer, sel.start, sel.end);
    onBufferChanged();
    showToast('Trimmed to selection', 'success');
  } catch (err) {
    showToast('Trim failed: ' + err.message, 'error');
  }
}

function doDelete() {
  const sel = getSelectionRange();
  if (!sel) { showToast('Select a region first', 'error'); return; }

  const ctx = getAudioContext();
  stopPlayback();
  pushUndo();

  try {
    state.sourceBuffer = deleteSection(ctx, state.sourceBuffer, sel.start, sel.end);
    state.selStart = null;
    state.selEnd   = null;
    onBufferChanged();
    showToast('Section deleted', 'success');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

function doAddMarker() {
  const t = state.currentTime;
  if (!state.sourceBuffer) return;
  // Avoid duplicate markers
  if (state.markers.some(m => Math.abs(m - t) < 0.05)) {
    showToast('Marker already near this position', 'info');
    return;
  }
  state.markers.push(t);
  state.markers.sort((a, b) => a - b);
  renderMarkers();
  showToast(`Marker added at ${formatTime(t, true)}`, 'info');
}

function doSplit() {
  if (!state.markers.length) {
    showToast('Add markers first (use Marker button)', 'error');
    return;
  }

  const ctx = getAudioContext();
  stopPlayback();

  try {
    state.segments = splitBuffer(ctx, state.sourceBuffer, state.markers);
    renderSegments();
    showToast(`Split into ${state.segments.length} segments`, 'success');
  } catch (err) {
    showToast('Split failed: ' + err.message, 'error');
  }
}

function doUndo() {
  if (!state.undoStack.length) {
    showToast('Nothing to undo', 'info');
    return;
  }
  stopPlayback();
  state.sourceBuffer = state.undoStack.pop();
  state.selStart = null;
  state.selEnd   = null;
  onBufferChanged();
  showToast('Undone', 'info');
}

function onBufferChanged() {
  const dur  = state.sourceBuffer.duration;
  const peakCount = Math.min(Math.max(el.waveformWrapper.clientWidth * 2, 800), 4000);
  state.waveformPeaks = extractWaveformPeaks(state.sourceBuffer, peakCount);
  state.currentTime   = 0;
  state.markers       = [];

  el.totalTime.textContent    = formatTime(dur);
  el.infoDuration.textContent = formatTime(dur);

  // Reset zoom if necessary
  if (state.zoomLevel > 1) {
    state.scrollOffset = 0;
    setZoom(1);
  }
  renderMarkers();
  drawWaveform();
}

/* ══════════════════════════════════════════════════════════
   MARKERS
   ══════════════════════════════════════════════════════════ */

function renderMarkers() {
  el.markerLayer.innerHTML = '';

  state.markers.forEach((t, i) => {
    const px   = timeToPx(t);
    const line = document.createElement('div');
    line.className    = 'marker-line';
    line.style.left   = px + 'px';
    line.dataset.index = i + 1;
    line.title        = `Marker ${i + 1}: ${formatTime(t, true)} — click to remove`;

    line.addEventListener('click', () => {
      state.markers.splice(i, 1);
      renderMarkers();
      showToast(`Marker ${i + 1} removed`, 'info');
    });

    el.markerLayer.appendChild(line);
  });
}

/* ══════════════════════════════════════════════════════════
   SEGMENTS PANEL
   ══════════════════════════════════════════════════════════ */

function renderSegments() {
  el.segmentsPanel.style.display = 'block';
  el.segmentsList.innerHTML = '';

  state.segments.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'segment-card';

    const dur = seg.endSec - seg.startSec;
    card.innerHTML = `
      <span class="seg-num">${i + 1}</span>
      <span class="seg-info">${formatTime(seg.startSec, true)} – ${formatTime(seg.endSec, true)}</span>
      <span class="seg-info" style="color:var(--text-muted)">${formatTime(dur, true)}</span>
      <button class="seg-dl">↓ WAV</button>
    `;

    card.querySelector('.seg-dl').addEventListener('click', async () => {
      showProgress('Exporting segment…', 0);
      try {
        const result = await exportAudio(seg.buffer, 'wav', p => updateProgress(p, 'Exporting…'));
        const name   = `${state.fileName}_segment_${i + 1}.${result.ext}`;
        downloadBlob(result.blob, name);
        hideProgress();
        showToast(`Segment ${i + 1} exported`, 'success');
      } catch (err) {
        hideProgress();
        showToast('Export failed', 'error');
      }
    });

    el.segmentsList.appendChild(card);
  });
}

/* ══════════════════════════════════════════════════════════
   EXPORT MODAL
   ══════════════════════════════════════════════════════════ */

let exportState = { format: 'wav', scope: 'full' };

function openExportModal() {
  if (!state.sourceBuffer) return;

  const baseName = state.fileName || 'output';
  el.exportName.value = baseName + '_edited';

  // Dim "Selection Only" button if no selection (use class, not disabled, so it stays clickable)
  const hasSel = state.selStart !== null && Math.abs(state.selEnd - state.selStart) > 0.01;
  el.scopeSelection.classList.toggle('fmt-unavailable', !hasSel);
  if (!hasSel && exportState.scope === 'selection') {
    exportState.scope = 'full';
    updateFmtButtons('scope');
  }

  el.exportModal.style.display = 'flex';
}

function closeExportModal() {
  el.exportModal.style.display = 'none';
}

function updateFmtButtons(type) {
  const isFormat = type === 'format';
  const group    = isFormat ? '.format-btns:first-of-type' : '.format-btns:last-of-type';
  el.exportModal.querySelectorAll(`[data-${isFormat ? 'fmt' : 'scope'}]`).forEach(btn => {
    const val = btn.dataset[isFormat ? 'fmt' : 'scope'];
    btn.classList.toggle('active', val === (isFormat ? exportState.format : exportState.scope));
  });
}

async function doExport() {
  if (!state.sourceBuffer) return;

  let buffer = state.sourceBuffer;

  // Slice to selection if needed
  if (exportState.scope === 'selection' && state.selStart !== null) {
    const ctx = getAudioContext();
    const s   = Math.min(state.selStart, state.selEnd);
    const e   = Math.max(state.selStart, state.selEnd);
    buffer    = sliceBuffer(ctx, buffer, s, e);
  }

  const name = (el.exportName.value.trim() || 'output').replace(/[/\\?%*:|"<>]/g, '_');

  closeExportModal();
  showProgress('Exporting audio…', 0);

  try {
    const result = await exportAudio(
      buffer,
      exportState.format,
      p => updateProgress(p, 'Encoding…')
    );

    downloadBlob(result.blob, `${name}.${result.ext}`);
    hideProgress();
    showToast(`Exported as ${result.format}`, 'success');
  } catch (err) {
    hideProgress();
    showToast('Export failed: ' + err.message, 'error');
    console.error('[doExport]', err);
  }
}

/* ══════════════════════════════════════════════════════════
   PROGRESS / TOAST UI
   ══════════════════════════════════════════════════════════ */

function showProgress(label, pct) {
  el.progressOverlay.style.display = 'flex';
  el.progressLabel.textContent     = label;
  el.progressBarFill.style.width   = (pct * 100) + '%';
}

function updateProgress(pct, label) {
  el.progressBarFill.style.width = (pct * 100) + '%';
  if (label) el.progressLabel.textContent = label;
}

function hideProgress() {
  el.progressOverlay.style.display = 'none';
}

let _toastTimer;
function showToast(msg, type = '') {
  clearTimeout(_toastTimer);
  el.toast.textContent  = msg;
  el.toast.className    = 'toast show' + (type ? ' ' + type : '');
  _toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
  }, 3000);
}

/* ══════════════════════════════════════════════════════════
   WAVEFORM MOUSE/TOUCH EVENTS (selection + seek)
   ══════════════════════════════════════════════════════════ */

let _isDraggingSel  = false;
let _isDraggingScroll = false;
let _dragScrollStart  = 0;
let _dragScrollOffset = 0;

function getWaveformX(e) {
  const rect = el.waveformWrapper.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  return Math.max(0, Math.min(clientX - rect.left, state.canvasWidth));
}

el.waveformWrapper.addEventListener('mousedown', handleWaveformDown);
el.waveformWrapper.addEventListener('touchstart', handleWaveformDown, { passive: false });

function handleWaveformDown(e) {
  if (!state.sourceBuffer) return;
  e.preventDefault();

  const x = getWaveformX(e);
  const t = pxToTime(x);

  _isDraggingSel = true;
  state.selStart  = t;
  state.selEnd    = t;

  // Move playhead to click point
  state.currentTime = t;
  el.currentTime.textContent = formatTime(t, true);
  if (state.isPlaying) {
    startPlayback(t);
  } else {
    updatePlayheadPosition();
  }
}

document.addEventListener('mousemove', handleWaveformMove);
document.addEventListener('touchmove', handleWaveformMove, { passive: false });

function handleWaveformMove(e) {
  if (!_isDraggingSel || !state.sourceBuffer) return;
  if (e.touches) e.preventDefault();

  const x = getWaveformX(e);
  state.selEnd = pxToTime(x);
  updateSelectionOverlay();
}

document.addEventListener('mouseup',   handleWaveformUp);
document.addEventListener('touchend',  handleWaveformUp);

function handleWaveformUp() {
  if (_isDraggingSel) {
    _isDraggingSel = false;
    // Normalize selection
    if (state.selStart !== null && Math.abs(state.selEnd - state.selStart) < 0.01) {
      state.selStart = null;
      state.selEnd   = null;
      updateSelectionOverlay();
    }
  }
}

/* ──────── Scroll thumb drag ──────── */
el.scrollThumb.addEventListener('mousedown', e => {
  _isDraggingScroll = true;
  _dragScrollStart  = e.clientX;
  _dragScrollOffset = state.scrollOffset;
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!_isDraggingScroll || !state.sourceBuffer) return;
  const trackW     = el.scrollTrack.clientWidth;
  const duration   = state.sourceBuffer.duration;
  const delta      = e.clientX - _dragScrollStart;
  const deltaSec   = (delta / trackW) * duration;
  scrollTo(_dragScrollOffset + deltaSec);
});

document.addEventListener('mouseup', () => { _isDraggingScroll = false; });

/* ──────── Scroll on waveform (mouse wheel) ──────── */
el.waveformWrapper.addEventListener('wheel', e => {
  e.preventDefault();
  if (!state.sourceBuffer) return;

  if (e.ctrlKey || e.metaKey) {
    // Pinch-to-zoom / Ctrl+scroll = zoom
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    setZoom(state.zoomLevel * factor);
  } else {
    // Regular scroll = pan
    const duration   = state.sourceBuffer.duration;
    const visibleDur = duration / state.zoomLevel;
    const delta      = (e.deltaX || e.deltaY) * 0.001 * visibleDur * 3;
    scrollTo(state.scrollOffset + delta);
  }
}, { passive: false });

/* ══════════════════════════════════════════════════════════
   TOUCH PINCH-TO-ZOOM
   ══════════════════════════════════════════════════════════ */

let _lastPinchDist = null;

el.waveformWrapper.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    _lastPinchDist = getPinchDist(e.touches);
    e.preventDefault();
  }
}, { passive: false });

el.waveformWrapper.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && _lastPinchDist) {
    const dist  = getPinchDist(e.touches);
    const ratio = dist / _lastPinchDist;
    setZoom(state.zoomLevel * ratio);
    _lastPinchDist = dist;
    e.preventDefault();
  }
}, { passive: false });

el.waveformWrapper.addEventListener('touchend', e => {
  if (e.touches.length < 2) _lastPinchDist = null;
});

function getPinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ══════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ══════════════════════════════════════════════════════════ */

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (state.isPlaying) pausePlayback();
      else startPlayback();
      break;
    case 'Escape':
      stopPlayback();
      break;
    case 'ArrowLeft':
      if (!state.sourceBuffer) break;
      state.currentTime = Math.max(0, state.currentTime - (e.shiftKey ? 5 : 1));
      el.currentTime.textContent = formatTime(state.currentTime, true);
      updatePlayheadPosition();
      break;
    case 'ArrowRight':
      if (!state.sourceBuffer) break;
      state.currentTime = Math.min(
        state.sourceBuffer.duration,
        state.currentTime + (e.shiftKey ? 5 : 1)
      );
      el.currentTime.textContent = formatTime(state.currentTime, true);
      updatePlayheadPosition();
      break;
    case '+': case '=':
      setZoom(state.zoomLevel * 1.25);
      break;
    case '-':
      setZoom(state.zoomLevel * 0.8);
      break;
    case 'm': case 'M':
      doAddMarker();
      break;
    case 'z':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); doUndo(); }
      break;
    case 'a':
      if ((e.ctrlKey || e.metaKey) && state.sourceBuffer) {
        e.preventDefault();
        state.selStart = 0;
        state.selEnd   = state.sourceBuffer.duration;
        updateSelectionOverlay();
      }
      break;
  }
});

/* ══════════════════════════════════════════════════════════
   BUTTON EVENT LISTENERS
   ══════════════════════════════════════════════════════════ */

// ── File loading ──
el.btnUpload.addEventListener('click',  () => el.fileInput.click());
el.fileInput.addEventListener('change', e  => e.target.files[0] && loadFile(e.target.files[0]));

// Drop zone
el.dropZone.addEventListener('click', e => {
  if (e.target === el.btnUpload) return;
  el.fileInput.click();
});

el.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  el.dropZone.classList.add('drag-over');
});

el.dropZone.addEventListener('dragleave', e => {
  if (!el.dropZone.contains(e.relatedTarget)) {
    el.dropZone.classList.remove('drag-over');
  }
});

el.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// Drag and drop on editor too (for re-loading)
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// ── Transport ──
el.btnPlay.addEventListener('click', () => {
  if (state.isPlaying) pausePlayback();
  else startPlayback();
});

el.btnStop.addEventListener('click', () => stopPlayback(true));

el.btnLoop.addEventListener('click', () => {
  state.loopMode = !state.loopMode;
  el.btnLoop.classList.toggle('active', state.loopMode);
  showToast(state.loopMode ? 'Loop on' : 'Loop off', 'info');
});

// ── Speed ──
el.speedSlider.addEventListener('input', () => {
  state.speed = parseFloat(el.speedSlider.value);
  el.speedLabel.textContent = state.speed.toFixed(2).replace(/\.?0+$/, '') + '×';
  if (state.sourceNode) state.sourceNode.playbackRate.value = state.speed;
});

// ── Volume ──
el.volumeSlider.addEventListener('input', () => {
  state.volume = parseFloat(el.volumeSlider.value);
  el.volumeLabel.textContent = Math.round(state.volume * 100) + '%';
  if (state.gainNode) state.gainNode.gain.value = state.volume;
});

// ── Zoom ──
el.btnZoomIn .addEventListener('click', () => setZoom(state.zoomLevel * 1.5));
el.btnZoomOut.addEventListener('click', () => setZoom(state.zoomLevel / 1.5));

// ── Selection ──
el.btnSelectAll.addEventListener('click', () => {
  if (!state.sourceBuffer) return;
  state.selStart = 0;
  state.selEnd   = state.sourceBuffer.duration;
  updateSelectionOverlay();
});

el.btnClearSel.addEventListener('click', () => {
  state.selStart = null;
  state.selEnd   = null;
  updateSelectionOverlay();
});

// ── Edit operations ──
el.btnTrim     .addEventListener('click', doTrim);
el.btnDelete   .addEventListener('click', doDelete);
el.btnAddMarker   .addEventListener('click', doAddMarker);
el.btnClearMarkers.addEventListener('click', () => {
  if (!state.markers.length) { showToast('No markers to clear', 'info'); return; }
  state.markers = [];
  renderMarkers();
  showToast('All markers cleared', 'info');
});
el.btnSplit    .addEventListener('click', doSplit);
el.btnUndo     .addEventListener('click', doUndo);
el.btnExport   .addEventListener('click', openExportModal);

// ── Export all segments ──
el.btnExportAll.addEventListener('click', async () => {
  if (!state.segments.length) return;
  for (let i = 0; i < state.segments.length; i++) {
    const seg = state.segments[i];
    showProgress(`Exporting segment ${i + 1}/${state.segments.length}…`, i / state.segments.length);
    const result = await exportAudio(seg.buffer, 'wav', null);
    downloadBlob(result.blob, `${state.fileName}_segment_${i + 1}.${result.ext}`);
    await new Promise(r => setTimeout(r, 300)); // slight delay between downloads
  }
  hideProgress();
  showToast('All segments exported', 'success');
});

// ── Export modal ──
el.exportModal.querySelectorAll('[data-fmt]').forEach(btn => {
  btn.addEventListener('click', () => {
    exportState.format = btn.dataset.fmt;
    el.exportModal.querySelectorAll('[data-fmt]').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
  });
});

el.exportModal.querySelectorAll('[data-scope]').forEach(btn => {
  btn.addEventListener('click', () => {
    exportState.scope = btn.dataset.scope;
    el.exportModal.querySelectorAll('[data-scope]').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
  });
});

el.btnCancelExport .addEventListener('click', closeExportModal);
el.btnConfirmExport.addEventListener('click', doExport);
el.exportModal.addEventListener('click', e => {
  if (e.target === el.exportModal) closeExportModal();
});

/* ══════════════════════════════════════════════════════════
   RESIZE HANDLER
   ══════════════════════════════════════════════════════════ */

let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (state.sourceBuffer) {
      resizeCanvas();
      drawWaveform();
      renderMarkers();
      updateScrollThumb();
    }
  }, 100);
});

/* ══════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════ */

(function init() {
  // Check for MP3 encoding capability and update modal label
  isMp3Available().then(avail => {
    const note = el.fmtMp3.querySelector('.fmt-note');
    if (note) {
      note.textContent = avail ? '(192kbps)' : '(not available)';
    }
    if (!avail) {
      el.fmtMp3.style.opacity = '0.5';
    }
  });

  console.log('%cWaveCut MP3 Editor loaded', 'color:#00e5cc;font-weight:bold');
  console.log('Keyboard shortcuts: SPACE=play/pause, ESC=stop, M=marker, Ctrl+Z=undo, Ctrl+A=select all');
})();
