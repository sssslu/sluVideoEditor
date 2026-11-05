# Continuous audio speed curves

`slu-audio-stretch.exe` is a statically linked Windows worker built from Rubber
Band 4.0.0 and the small, reproducible modifications in `patch-rubberband.mjs`.
It is CPU audio processing; video hardware decoding and encoding are separate.

Build from the repository root with a 64-bit MinGW C++ compiler, Node.js and
Windows `tar.exe` available:

```powershell
node scripts/build-audio-stretch.mjs
```

The build script verifies the official source archive SHA-256, extracts a fresh
copy, applies the patch, builds a static executable, rejects non-system DLL
imports, and writes binary/source/recipe hashes to
`resources/licenses/audio-stretch-manifest.json`. `CXX` may select the compiler.
The original archive, GPL license and exact source modification are retained in
`resources/licenses`. The application source distribution also includes this
worker and its build script. Rubber Band and the modifications are available
under GPL-2.0-or-later; the worker is GPL-3.0-or-later.

Each active curved audio clip uses one original-media FFmpeg decoder and one
continuous worker. The worker holds at most 64 curve control points and fixed
PCM blocks. It does not retain a whole clip or construct a duration-sized map.
Node streams both pipes concurrently with backpressure. Cancellation closes and
waits for both processes. Delayed stream starts and timestamp gaps are restored
by FFmpeg resampling before stretching. The final project mixer applies clip
gain/fades, then the output encoder applies one limiter after all clips mix.

Curve rates are linear in output timeline time, so source time is quadratic.
The worker evaluates its analytic inverse at every R3 analysis hop and uses
differences of rounded cumulative output positions. This prevents accumulated
rounding drift. Rapid bends reduce the hop where needed to retain window
overlap. One FFT/phase state continues through the entire clip;
there are no independently processed quarter-second joins. A second patch
preserves source phase differences between channels per FFT bin, using the
strongest channel's phase advance and independent channel magnitudes. This
avoids both stereo-image drift and mid/side transient coupling.

The private binary protocol starts with one UTF-8 line:

```
SLURB3 inputFrames outputFrames cropStart cropFrames pointCount duration sourceOffset renderFrom renderTo
```

It is followed by `pointCount` lines of `normalizedPosition absoluteSpeed`, then
exactly `inputFrames` interleaved stereo float32 little-endian frames at 48 kHz.
The output is exactly `cropFrames` frames in the same PCM format. Input includes
bounded endpoint context; `sourceOffset` is relative to the clip source in-point.
`renderFrom` and `renderTo` are local timeline seconds on the original clip;
transition handles may extend before zero or after `duration`. The original
curve points remain unchanged and endpoint rates extrapolate outside the clip.
The worker also accepts the legacy SLURB2 header, whose render range is
`[0,duration]`.
Malformed counts, non-finite values, invalid rates, non-increasing positions,
inconsistent inverse-map bounds and truncated PCM are rejected with a nonzero
exit. No command shell or media paths are passed to the native worker.

Regression coverage is in `tests/speed-render.test.ts` and
`tests/audio-timestamps.test.ts`: exact video window parity, sample counts,
source landmarks, pitch, muxed A/V sync, split clips, rapid curves, stereo phase,
bounded memory, cancellation and malformed worker input. Measured artifacts are
under `.test-artifacts/speed-render` and `.test-artifacts/audio-review`.

An extreme curve alternating 0.1× and 16× every127ms retains timing and sample
count but can cause audible pitch modulation. It is recorded separately in
`rapid-results.json`; it is not included in the ordinary curves' verified
pitch-preservation claim. Smooth curves and extreme constant rates have their
own strict pitch and timing regressions. Further transient/pitch quality work
for rapidly oscillating rates remains an explicit limitation.
