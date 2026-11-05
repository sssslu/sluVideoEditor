# SLU Studio — third-party components

Recorded for the Windows x64 build on 2026-10-30. License texts below are retained verbatim in adjacent files. The SLU Studio source project is supplied separately in the workspace and declares GPL-3.0-or-later. No CapCut code or assets are included.

## Included runtime components

| Component | Exact shipped version | License / local notice | Source |
| --- | --- | --- | --- |
| FFmpeg and FFprobe, Gyan static full build | `8.0.1-full_build-www.gyan.dev` | GPL-3.0-or-later; `FFmpeg-GPL.txt`, `FFmpeg-build.txt`, `FFmpeg-version.txt` | [Gyan release](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1), [FFmpeg source commit 894da5ca7d](https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d) |
| Rubber Band Library in `slu-audio-stretch.exe` | `4.0.0`, with the included SLU continuous time-map modification | GPL-2.0-or-later; `RubberBand-LICENSE.txt`, `RubberBand-SLU-patch.mjs`, `audio-stretch-manifest.json` | Included upstream `rubberband-4.0.0-source.tar.bz2`; application source archive contains the helper and reproducible patch/build scripts |
| Static audio-helper compiler runtimes | GCC `16.1.0` / MinGW-w64 `14.0.0`, WinLibs UCRT POSIX r3 | GCC GPLv3 with Runtime Library Exception 3.1; MinGW component notices retained in `audio-stretch-toolchain-LICENSES.txt` | Matching upstream release-tag URLs, hashes and local toolchain version evidence in `audio-stretch-toolchain-manifest.json`; compiler executable is not shipped |
| Electron | `45.1.0`, Windows x64 | MIT; `Electron-LICENSE.txt`; Chromium/Node/other runtime notices in `Electron-LICENSES.chromium.html` | [Electron v45.1.0 source](https://github.com/electron/electron/tree/v45.1.0) |
| React | `19.3.1` | MIT; `npm-production-LICENSES.txt` | [Exact npm source archive](https://registry.npmjs.org/react/-/react-19.3.1.tgz) |
| React DOM | `19.3.1` | MIT; `npm-production-LICENSES.txt` | [Exact npm source archive](https://registry.npmjs.org/react-dom/-/react-dom-19.3.1.tgz) |
| scheduler | `0.28.0` | MIT; `npm-production-LICENSES.txt` | [Exact npm source archive](https://registry.npmjs.org/scheduler/-/scheduler-0.28.0.tgz) |
| lucide-react | `0.468.0` | ISC, with Feather-origin icons under MIT; `npm-production-LICENSES.txt`, `Lucide-Feather-LICENSE.txt` | [Exact npm source archive](https://registry.npmjs.org/lucide-react/-/lucide-react-0.468.0.tgz), [Lucide source](https://github.com/lucide-icons/lucide/tree/0.468.0) |
| whisper.cpp integration | Gyan FFmpeg 8.0.1 build reports whisper.cpp `1.8.2` in `FFmpeg-build.txt` | MIT; `Whisper-LICENSE.txt` | [whisper.cpp v1.8.2](https://github.com/ggml-org/whisper.cpp/tree/v1.8.2), Gyan build manifest above |
| whisper.cpp CLI and ggml CPU runtime | `1.8.7` official Windows x64 archive | MIT; `Whisper-cli-LICENSE.txt`, `GGML-LICENSE.txt` | [Pinned release](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.7); archive digest in `whisper-cli-version.json` |
| yauzl and runtime dependencies | Exact versions in `npm-production-manifest.json` | MIT notices in `npm-production-LICENSES.txt` | Exact npm source archive URLs are recorded in the manifest |
| ViTTrack model and OpenCV adapter (development version 1.9) | Pinned commits and SHA-256 in `ViTTrack-provenance.json` | Apache-2.0; `ViTTrack-LICENSE.txt`, `ViTTrack-OpenCV-LICENSE.txt`; original adapter author Pengyu Liu | Unmodified 714,726-byte ONNX model; bounded TypeScript adapter in `electron/tracking-math.ts`; original adapter retained as `ViTTrack-upstream.cpp` |
| ONNX Runtime Node and common packages (development version 1.9) | `1.31.1` | MIT; `ONNXRuntime-LICENSE.txt`, `ONNXRuntime-ThirdPartyNotices.txt` | Exact npm tarballs and integrity in the lockfile and npm manifest; Windows x64 native file hashes in `ONNXRuntime-binaries.json` |
| DirectML redistributable (development version 1.9) | `1.15.4` | Microsoft software terms, code license and third-party notices in `DirectML-*` | Microsoft.AI.DirectML 1.15.4 NuGet archive, source and entry hashes in `ViTTrack-provenance.json`; retained native DLL from the pinned ONNX Runtime package |
| DirectX Shader Compiler (development version 1.9) | `1.8.2502.8`, source revision `b4711839e` | `DXC-LICENSE.txt` contains LLVM, MIT and component notices | [Exact revision](https://github.com/microsoft/DirectXShaderCompiler/tree/b4711839e); binary hash in `ONNXRuntime-binaries.json` |
| Noto Sans KR and Noto Emoji | Pinned original font files in `NotoSansKR-manifest.json` and `NotoEmoji-manifest.json` | SIL Open Font License 1.1, retained in the adjacent `*-OFL.txt` files | Original source URLs and file hashes in the font manifests |
| Gmarket Sans Medium and Bold | Two original TTF files, hashes in `GmarketSans-manifest.json` | Original embedded license retained in `GmarketSans-LICENSE.txt` | [Gmarket font distribution](https://corp.gmarket.com/fonts/) |

Version 1.11 adds the optional SeedVR2 enhancement runtime. The application ships its worker, installation manifest and notices in `resources/enhancement`. The installer downloads the exact archives and model files listed in `backend-manifest.json`, verifies their hashes and validates the installed file inventory. Runtime dependency license files are retained with the installed Python packages and in the runtime's `licenses` directory.

The enhancement backend uses the numz SeedVR2 source revision `4490bd1f482e026674543386bb2a4d176da245b9` and the 3B FP16 DiT and VAE weights from model revision `09ced71023636e9bc8cdf9cdecfb2625d1e691e8`. Source and model notices are retained under `resources/enhancement/licenses`, including the Apache-2.0 text and pinned model card. The exact upstream archive and weight URLs are in the installation manifest. [SeedVR2 implementation](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler/tree/4490bd1f482e026674543386bb2a4d176da245b9), [model repository](https://huggingface.co/numz/SeedVR2_comfyUI/tree/09ced71023636e9bc8cdf9cdecfb2625d1e691e8).

The downloaded environment includes CPython 3.13.17, PyTorch 2.9.1 with CUDA 12.8, and their pinned Python dependencies. Python, PyTorch, NVIDIA CUDA, cuDNN and Microsoft Visual C++ runtime files retain their respective license terms. Microsoft runtime DLLs are deployed beside the private Python executable. Payload provenance, included notices and exact hashes are recorded in the manifest and `resources/enhancement/licenses/metadata.json`.

The tracking components above shipped in version 1.9.0. The preserved 1.8.0 EXEs do not include object tracking. The OpenCV test videos used in research are not part of either the application or the source archive.

Development version 1.10 adds the original RVM MobileNetV3 FP32 ONNX model from [RobustVideoMatting v1.0.0](https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0), by Shanchuan Lin, Linjie Yang, Imran Saleemi and Soumyadip Sengupta, under GPL-3.0. CPU execution uses the original 14,975,696-byte model. DirectML uses a modified 14,979,595-byte graph with byte-input and BGRA-output adapters; upstream weights and the recurrent network are unchanged. `scripts/build-matting-model.py` reproduces the derived model. Both model digests, the recipe digest and upstream source commit are recorded in `RVM-provenance.json`; the license is retained in `RVM-LICENSE.txt`. The model performs human video matting and uses the already listed ONNX Runtime/DirectML binaries. Public evaluation footage linked by the authors is downloaded only into the development cache and is excluded from the app and source archive. The preserved 1.9.0 EXEs do not include this model or workflow.

Optional downloads in version 1.1: Whisper small (`ggml-small.bin`, 487601967 bytes, SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`), large-v3-turbo Q5 (`ggml-large-v3-turbo-q5_0.bin`, 574041195 bytes, SHA-256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`). Both originate from the same upstream model repository and use the retained Whisper model license.

The optional NVIDIA CUDA speech runtime is downloaded from the official whisper.cpp `v1.8.7` release asset `whisper-cublas-12.4.0-bin-x64.zip`, SHA-256 `ce5e66c7e45985f497e3a81c9d33723f19b3118993b47f53b8351df5cbb20402`. It is not embedded in the application EXE. Its CUDA libraries are NVIDIA components; see [CUDA 12.4 EULA](https://docs.nvidia.com/cuda/archive/12.4.0/eula/index.html).

The optional speech model is **Whisper base multilingual**, converted to GGML (`ggml-base.bin`). It is downloaded separately and is not embedded in the EXE. Exact content: 147,951,465 bytes, SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. The OpenAI model license is retained in `Whisper-model-LICENSE.txt` (MIT). Model source: [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-base.bin); original model project: [openai/whisper](https://github.com/openai/whisper).

`npm-production-manifest.json` records the exact lockfile source URLs, integrity values and copied license-text hashes. Build-only tools are pinned in `package-lock.json`; they are not shipped as an application runtime.

## Included source material and coverage

- `sources/ffmpeg-8.0.1.tar.xz`: unmodified upstream FFmpeg 8.0.1 source, 11,388,848 bytes. SHA-256 `05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41`.
- `sources/ffmpeg-8.0.1.tar.xz.asc` and `sources/ffmpeg-release-key.asc`: upstream detached signature and public key. The archive was verified against fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`, which is published on the [official download page](https://ffmpeg.org/download.html). Verification record: `sources/verification.json`.
- The original Gyan build description and full enabled-library list are retained in `FFmpeg-build.txt`; the actual executable configure arguments are in `FFmpeg-version.txt`.

The included archives cover the FFmpeg upstream project. Gyan's bundled README reports versions and short commit IDs for many external libraries. Exact sources for every statically linked dependency, the complete toolchain and the build recipe used for this binary remain incomplete. Recorded versions, upstream source locations and unresolved items are documented in `FFmpeg-external-sources.md`. The application preparation scripts use checksum-pinned upstream executables.

## Rebuilding this application on Windows

Use Node.js 22.12+ (the tested Node version is 22.22.0), npm and the supplied source project including `package-lock.json`.

```powershell
npm ci
node scripts/prepare-ffmpeg.mjs
node scripts/fetch-whisper.mjs
node scripts/build-audio-stretch.mjs
node scripts/collect-licenses.mjs
npm test
npm run build
npm run package
```

`prepare-ffmpeg.mjs` checks the existing executables first, reuses a matching local Chocolatey installation if available, and only otherwise downloads the exact Gyan full-build ZIP. The official ZIP SHA-256 is pinned to `467cde100a47ed4b03a897988aeb4a296890c1e2b2d2864204657d002bc5fb90`. `--verify-only` performs offline executable checks. It never replaces a binary with an unverified download.

The audio helper requires MinGW-w64 `g++`, `objdump`, and `tar` on PATH. `build-audio-stretch.mjs` verifies Rubber Band's upstream source SHA-256 `af050313ee63bc18b35b2e064e5dce05b276aaf6d1aa2b8a82ced1fe2f8028e9`, applies `native/patch-rubberband.mjs`, statically links the helper, and checks its DLL imports. `audio-stretch-manifest.json` records source, recipe, and executable hashes plus compiler details. The patch evaluates the continuous inverse speed curve on each R3 analysis hop while retaining FFT and phase state. The helper source is GPL-3.0-or-later.

Electron is installed by npm's postinstall step. If an environment disabled install scripts, run `node node_modules/electron/install.js` before license collection or packaging. Packaging includes this `licenses` directory via `extraResources`.

## Inter

UI product wordmark uses Inter Bold from the local SluCompany branding kit. Copyright (c) 2016 The Inter Project Authors. SIL Open Font License 1.1; see `Inter-LICENSE.txt`. Caption font choices are unchanged.
