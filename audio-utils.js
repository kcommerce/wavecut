/**
 * audio-utils.js
 * ──────────────────────────────────────────────────────────
 * Low-level audio processing utilities using Web Audio API.
 * All functions operate on AudioBuffer objects (PCM data).
 *
 * Key concepts:
 *  - AudioBuffer: holds decoded PCM float32 samples per channel
 *  - sampleRate: samples per second (e.g. 44100 Hz)
 *  - frame: one sample across all channels at a given point in time
 * ──────────────────────────────────────────────────────────
 */

'use strict';

/* ──────────────────────────────────────────────────────────
   TIME FORMATTING
   ────────────────────────────────────────────────────────── */

/**
 * Format seconds to mm:ss.t  (e.g. 1:23.4)
 * @param {number} secs
 * @param {boolean} showTenths
 * @returns {string}
 */
function formatTime(secs, showTenths = false) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const t = Math.floor((secs % 1) * 10);
  const ss = s < 10 ? '0' + s : '' + s;
  return showTenths ? `${m}:${ss}.${t}` : `${m}:${ss}`;
}

/**
 * Format bytes to human-readable (KB / MB)
 */
function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/* ──────────────────────────────────────────────────────────
   AUDIOBUFFER SLICING
   Extracts a sub-region from an AudioBuffer.
   ────────────────────────────────────────────────────────── */

/**
 * Slice an AudioBuffer between startSec and endSec.
 * Returns a new AudioBuffer with the extracted region.
 *
 * @param {AudioContext} ctx
 * @param {AudioBuffer}  buffer   - source buffer
 * @param {number}       startSec - start time in seconds
 * @param {number}       endSec   - end time in seconds
 * @returns {AudioBuffer}
 */
function sliceBuffer(ctx, buffer, startSec, endSec) {
  const sr = buffer.sampleRate;
  const startFrame = Math.max(0, Math.floor(startSec * sr));
  const endFrame   = Math.min(buffer.length, Math.ceil(endSec * sr));
  const frameCount = endFrame - startFrame;

  if (frameCount <= 0) throw new Error('Invalid slice range: empty region');

  const out = ctx.createBuffer(buffer.numberOfChannels, frameCount, sr);

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    // Get source channel data (Float32Array)
    const src = buffer.getChannelData(ch);
    // Get output channel data view
    const dst = out.getChannelData(ch);
    // Copy the slice
    dst.set(src.subarray(startFrame, endFrame));
  }

  return out;
}

/* ──────────────────────────────────────────────────────────
   AUDIOBUFFER CONCATENATION
   Joins multiple AudioBuffers end-to-end.
   ────────────────────────────────────────────────────────── */

/**
 * Concatenate an array of AudioBuffers into one.
 * All buffers must share the same sampleRate and numberOfChannels.
 *
 * @param {AudioContext}   ctx
 * @param {AudioBuffer[]}  buffers
 * @returns {AudioBuffer}
 */
function concatenateBuffers(ctx, buffers) {
  if (!buffers.length) throw new Error('No buffers to concatenate');

  const sr  = buffers[0].sampleRate;
  const nch = buffers[0].numberOfChannels;
  const totalFrames = buffers.reduce((sum, b) => sum + b.length, 0);

  const out = ctx.createBuffer(nch, totalFrames, sr);

  for (let ch = 0; ch < nch; ch++) {
    const dst = out.getChannelData(ch);
    let offset = 0;
    for (const buf of buffers) {
      dst.set(buf.getChannelData(ch), offset);
      offset += buf.length;
    }
  }

  return out;
}

/* ──────────────────────────────────────────────────────────
   TRIM  — keep only the selected region
   ────────────────────────────────────────────────────────── */

/**
 * Trim: keep [startSec, endSec], discard the rest.
 * @param {AudioContext} ctx
 * @param {AudioBuffer}  buffer
 * @param {number}       startSec
 * @param {number}       endSec
 * @returns {AudioBuffer}
 */
function trimBuffer(ctx, buffer, startSec, endSec) {
  return sliceBuffer(ctx, buffer, startSec, endSec);
}

/* ──────────────────────────────────────────────────────────
   DELETE SECTION — remove region and join remaining parts
   ────────────────────────────────────────────────────────── */

/**
 * Delete [startSec, endSec] and concatenate the two remaining pieces.
 * @param {AudioContext} ctx
 * @param {AudioBuffer}  buffer
 * @param {number}       startSec
 * @param {number}       endSec
 * @returns {AudioBuffer}
 */
function deleteSection(ctx, buffer, startSec, endSec) {
  const duration = buffer.duration;
  const parts = [];

  // Part before selection
  if (startSec > 0.001) {
    parts.push(sliceBuffer(ctx, buffer, 0, startSec));
  }
  // Part after selection
  if (endSec < duration - 0.001) {
    parts.push(sliceBuffer(ctx, buffer, endSec, duration));
  }

  if (!parts.length) throw new Error('Cannot delete entire audio');

  return parts.length === 1 ? parts[0] : concatenateBuffers(ctx, parts);
}

/* ──────────────────────────────────────────────────────────
   SPLIT — divide buffer at marker positions
   ────────────────────────────────────────────────────────── */

/**
 * Split an AudioBuffer at given time positions (markers).
 * Returns array of {buffer, startSec, endSec} segments.
 *
 * @param {AudioContext} ctx
 * @param {AudioBuffer}  buffer
 * @param {number[]}     markerTimes - sorted array of split times in seconds
 * @returns {Array<{buffer: AudioBuffer, startSec: number, endSec: number}>}
 */
function splitBuffer(ctx, buffer, markerTimes) {
  const duration = buffer.duration;

  // Build boundary list: 0, ...markers..., duration
  const boundaries = [0, ...markerTimes.filter(t => t > 0 && t < duration), duration];
  boundaries.sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end   = boundaries[i + 1];
    if (end - start < 0.01) continue; // skip tiny gaps

    segments.push({
      buffer:   sliceBuffer(ctx, buffer, start, end),
      startSec: start,
      endSec:   end,
    });
  }

  return segments;
}

/* ──────────────────────────────────────────────────────────
   WAVEFORM DATA EXTRACTION
   Down-samples PCM to pixel-level peak data for rendering.
   ────────────────────────────────────────────────────────── */

/**
 * Compute waveform peak data for rendering.
 * Returns Float32Array of [min, max] pairs per pixel column.
 *
 * @param {AudioBuffer} buffer
 * @param {number}      pixelWidth  - number of columns to compute
 * @returns {Float32Array} length = pixelWidth * 2  (min, max pairs)
 */
function extractWaveformPeaks(buffer, pixelWidth) {
  // Merge channels to mono by averaging
  const nch = buffer.numberOfChannels;
  const len = buffer.length;
  const mono = new Float32Array(len);

  for (let ch = 0; ch < nch; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      mono[i] += data[i] / nch;
    }
  }

  // Compute min/max per pixel column
  const peaks = new Float32Array(pixelWidth * 2);
  const samplesPerPixel = len / pixelWidth;

  for (let col = 0; col < pixelWidth; col++) {
    const start = Math.floor(col * samplesPerPixel);
    const end   = Math.floor((col + 1) * samplesPerPixel);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      const v = mono[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[col * 2]     = min;
    peaks[col * 2 + 1] = max;
  }

  return peaks;
}

/* ──────────────────────────────────────────────────────────
   WAV ENCODING
   Converts AudioBuffer → WAV Blob (no external library needed).
   ────────────────────────────────────────────────────────── */

/**
 * Encode an AudioBuffer as a WAV file Blob.
 * Uses 16-bit PCM, interleaved channels.
 *
 * @param {AudioBuffer} buffer
 * @returns {Blob}  WAV audio/wav Blob
 */
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate  = buffer.sampleRate;
  const numFrames   = buffer.length;
  const bytesPerSample = 2; // 16-bit

  // Interleave channels into one Int16 array
  const interleaved = new Int16Array(numFrames * numChannels);

  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      // Float32 [-1, 1] → Int16 [-32768, 32767]
      const sample = buffer.getChannelData(ch)[frame];
      const clamped = Math.max(-1, Math.min(1, sample));
      interleaved[frame * numChannels + ch] =
        clamped < 0 ? clamped * 32768 : clamped * 32767;
    }
  }

  // Build WAV header
  const dataSize   = interleaved.byteLength;
  const headerSize = 44;
  const wav = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(wav);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  const writeU16 = (o, v) => view.setUint16(o, v, true);
  const writeU32 = (o, v) => view.setUint32(o, v, true);

  // RIFF chunk
  writeString(0,  'RIFF');
  writeU32   (4,  36 + dataSize);
  writeString(8,  'WAVE');

  // fmt  sub-chunk
  writeString(12, 'fmt ');
  writeU32   (16, 16);                     // chunk size
  writeU16   (20, 1);                      // PCM format
  writeU16   (22, numChannels);
  writeU32   (24, sampleRate);
  writeU32   (28, sampleRate * numChannels * bytesPerSample); // byte rate
  writeU16   (32, numChannels * bytesPerSample);              // block align
  writeU16   (34, 16);                                        // bits per sample

  // data sub-chunk
  writeString(36, 'data');
  writeU32   (40, dataSize);

  // Write PCM data
  const outView = new Uint8Array(wav, headerSize);
  outView.set(new Uint8Array(interleaved.buffer));

  return new Blob([wav], { type: 'audio/wav' });
}

/* ──────────────────────────────────────────────────────────
   DOWNLOAD HELPER
   ────────────────────────────────────────────────────────── */

/**
 * Trigger a file download in the browser.
 * @param {Blob}   blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  // Revoke after short delay to allow download to start
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ──────────────────────────────────────────────────────────
   FILE SIZE ESTIMATOR
   ────────────────────────────────────────────────────────── */

/**
 * Estimate the WAV size of an AudioBuffer in bytes.
 */
function estimateWavSize(buffer) {
  return 44 + buffer.length * buffer.numberOfChannels * 2;
}
