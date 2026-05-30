# WaveCut MP3 Editor

A fully offline, browser-based audio editor. No installation, no server, no dependencies.

## Quick Start

1. Open `index.html` in Chrome, Edge, or Safari
2. Drop an audio file onto the page (MP3, WAV, OGG, M4A)
3. Edit and export

## Features

| Feature | Details |
|---|---|
| **Waveform** | Zoomable, scrollable, touch-friendly |
| **Trim** | Keep only selected region |
| **Delete** | Remove selected region, join remaining |
| **Split** | Place markers → split into downloadable segments |
| **Export** | WAV (always) · MP3 (add `libs/lame.min.js` for offline MP3) |
| **Undo** | Up to 20 steps |
| **Playback** | Speed 0.5×–2×, volume, loop selection |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Esc` | Stop |
| `M` | Add marker at playhead |
| `Ctrl+Z` | Undo |
| `Ctrl+A` | Select all |
| `←` / `→` | Nudge playhead 1s (+ Shift = 5s) |
| `+` / `-` | Zoom in / out |

## MP3 Export (Optional)

By default, export produces WAV. To enable MP3 encoding:

1. Download [lame.min.js](https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js)
2. Place it at `libs/lame.min.js`
3. Re-open the app — MP3 button will activate automatically

## File Structure

```
index.html       — Main UI
style.css        — Dark industrial theme
app.js           — Application logic, event handling, waveform
audio-utils.js   — PCM buffer operations (trim, delete, split, WAV encode)
encoder.js       — MP3 encoder wrapper (lamejs) + WAV fallback
libs/            — Optional: place lame.min.js here
```

## Browser Support

- Chrome 90+ ✓
- Edge 90+ ✓
- Safari 15+ ✓
- Firefox 90+ ✓ (WAV export only)
- iOS Safari 15+ ✓
- Android Chrome 90+ ✓

## Privacy

100% local processing. No data leaves your device. No analytics. No network requests after page load.
