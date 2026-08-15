# Rhythm generation pipeline

The game now uses Level v3 events with explicit `timeSeconds`. BPM remains song
metadata for visual presentation; it is not used to construct or quantize obstacle
times.

## Generate and compare

```powershell
npm run analyze:rhythm
npm run lab:rhythm
```

The first command runs three mature audio systems against the same decoded audio:

- librosa multi-band onset detection for percussion and broad-band transients;
- Spotify Basic Pitch ONNX for melodic note onsets;
- Beat This! for beat/downbeat context.

An L2-regularized logistic model learns which detector candidates resemble the
human taps. It may select or reject a candidate, but it cannot create, shift, or
snap timestamps. Generated tracks are written to
`src/levels/slice-at-two.levels.json`; the recommended track is also written to
`src/levels/slice-at-two.level.json`.

## Set up the analysis environment on Windows

Python 3.11 or 3.12 is recommended.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-rhythm-env.ps1 -PythonCommand python
```

Set `RHYTHM_PYTHON` if the environment lives elsewhere. The first analysis run
downloads the official Beat This! checkpoint into `.cache/`.

## Timing guarantees

- Human taps remain immutable in `data/annotations/` and can contain mistakes.
- The old grid output remains immutable in `data/baselines/` only for comparison.
- Every generated obstacle uses an audio-model candidate's original timestamp.
- The 120 ms minimum gap removes unsafe near-duplicates but never moves an event.
- Validation rejects Level v3 files that reintroduce `ticksPerBeat` or
  `beatOffsetSeconds`.
