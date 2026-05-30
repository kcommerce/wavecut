/**
 * encoder.js
 * ──────────────────────────────────────────────────────────
 * MP3 encoding wrapper.
 *
 * Strategy:
 *  1. Try to load lamejs dynamically (works when online OR if libs/lame.min.js exists)
 *  2. If lamejs unavailable, fall back to WAV encoding (always works offline)
 *
 * lamejs reference: https://github.com/nicktindall/lamejs
 * ──────────────────────────────────────────────────────────
 */

'use strict';

/* ──────────────────────────────────────────────────────────
   LAME LOADER — try CDN, then local fallback
   ────────────────────────────────────────────────────────── */

let _lameLoaded = false;
let _lameLoadAttempted = false;

/**
 * Try to load lamejs. Returns true if successful.
 * @returns {Promise<boolean>}
 */
async function tryLoadLame() {
  if (_lameLoadAttempted) return _lameLoaded;
  _lameLoadAttempted = true;

  // Try local file first (for offline use)
  const candidates = [
    'libs/lame.min.js',
  ];

  for (const src of candidates) {
    try {
      await loadScript(src);
      if (typeof lamejs !== 'undefined') {
        _lameLoaded = true;
        console.log('[encoder] lamejs loaded from:', src);
        return true;
      }
    } catch (_) { /* try next */ }
  }

  console.warn('[encoder] lamejs not available — will use WAV fallback');
  _lameLoaded = false;
  return false;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* ──────────────────────────────────────────────────────────
   MP3 ENCODING using lamejs
   ────────────────────────────────────────────────────────── */

/**
 * Encode an AudioBuffer to MP3 Blob using lamejs.
 * lamejs expects Int16 PCM samples per channel.
 *
 * @param {AudioBuffer} buffer
 * @param {number}      kbps   - bitrate (e.g. 128, 192, 320)
 * @param {function}    onProgress - callback(0-1)
 * @returns {Blob}  audio/mpeg
 */
function encodeToMp3(buffer, kbps = 128, onProgress = null) {
  if (typeof lamejs === 'undefined') {
    throw new Error('lamejs not loaded');
  }

  const nch        = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames  = buffer.length;

  // lamejs Mp3Encoder: (channels, sampleRate, kbps)
  const mp3enc = new lamejs.Mp3Encoder(nch, sampleRate, kbps);
  const mp3Data = [];

  // Convert Float32 to Int16 for each channel
  const toInt16 = (float32arr) => {
    const int16 = new Int16Array(float32arr.length);
    for (let i = 0; i < float32arr.length; i++) {
      const s = Math.max(-1, Math.min(1, float32arr[i]));
      int16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return int16;
  };

  const leftF32  = buffer.getChannelData(0);
  const rightF32 = nch > 1 ? buffer.getChannelData(1) : leftF32;

  // Encode in chunks to avoid blocking (chunk = ~1152 frames, MP3's frame size)
  const CHUNK = 1152;

  for (let i = 0; i < numFrames; i += CHUNK) {
    const end    = Math.min(i + CHUNK, numFrames);
    const left   = toInt16(leftF32.subarray(i, end));
    const right  = toInt16(rightF32.subarray(i, end));

    let encoded;
    if (nch === 1) {
      encoded = mp3enc.encodeBuffer(left);
    } else {
      encoded = mp3enc.encodeBuffer(left, right);
    }

    if (encoded.length > 0) mp3Data.push(encoded);

    if (onProgress) onProgress(end / numFrames);
  }

  // Flush remaining frames
  const flushed = mp3enc.flush();
  if (flushed.length > 0) mp3Data.push(flushed);

  return new Blob(mp3Data, { type: 'audio/mpeg' });
}

/* ──────────────────────────────────────────────────────────
   PUBLIC API
   ────────────────────────────────────────────────────────── */

/**
 * Export an AudioBuffer to the best available format.
 * Tries MP3 if lamejs is loaded; falls back to WAV.
 *
 * @param {AudioBuffer} buffer
 * @param {string}      preferredFormat  'mp3' | 'wav'
 * @param {function}    onProgress       callback(0-1)
 * @returns {{blob: Blob, ext: string, format: string}}
 */
async function exportAudio(buffer, preferredFormat = 'wav', onProgress = null) {
  // Check lamejs availability
  const lameAvailable = await tryLoadLame();

  if (preferredFormat === 'mp3' && lameAvailable) {
    try {
      const blob = encodeToMp3(buffer, 192, onProgress);
      return { blob, ext: 'mp3', format: 'MP3 192kbps' };
    } catch (err) {
      console.warn('[encoder] MP3 encoding failed, falling back to WAV:', err);
    }
  }

  // WAV fallback (always works, no external dependency)
  if (onProgress) onProgress(0.5);
  const blob = audioBufferToWav(buffer);
  if (onProgress) onProgress(1);
  return { blob, ext: 'wav', format: 'WAV 16-bit PCM' };
}

/**
 * Check if MP3 encoding is available.
 * @returns {Promise<boolean>}
 */
async function isMp3Available() {
  return tryLoadLame();
}
