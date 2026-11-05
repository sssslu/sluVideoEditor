# FFmpeg full-build source references

The shipped executables are the unmodified **Gyan 8.0.1 full static Windows x64 build**. The original adjacent `FFmpeg-build.txt` contains the enabled-library list and 74 external-library version entries. Of those entries, 36 include abbreviated Git commit identifiers. The compiler/configuration output is in `FFmpeg-version.txt`. Gyan identifies the FFmpeg source commit as [894da5ca7d](https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d).

The upstream FFmpeg source archive is included in `sources/`. The Gyan release asset, individual executable hashes, and source archive hash are pinned in `ffmpeg-manifest.json` and `scripts/prepare-ffmpeg.mjs`.

## Distributor and build source references

- [Gyan 8.0.1 binary release and source reference](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1)
- [Gyan build information, library list and contact](https://www.gyan.dev/ffmpeg/builds/)
- [FFmpeg 8.0.1 source tree](https://github.com/FFmpeg/FFmpeg/tree/n8.0.1)
- [FFmpeg external-library integration documentation](https://ffmpeg.org/general.html)

Selected directly used external components and their upstream repositories:

| Component / capability | Upstream source |
| --- | --- |
| x264, CPU H.264 encoding | https://code.videolan.org/videolan/x264 |
| x265, CPU HEVC encoding | https://bitbucket.org/multicoreware/x265_git/ |
| SVT-AV1, CPU AV1 encoding | https://gitlab.com/AOMediaCodec/SVT-AV1 |
| libvpx, VP9 encoding | https://chromium.googlesource.com/webm/libvpx/ |
| libass, styled subtitles | https://github.com/libass/libass/commit/e60dddb |
| FreeType, font rendering | https://gitlab.freedesktop.org/freetype/freetype |
| HarfBuzz, text shaping | https://github.com/harfbuzz/harfbuzz |
| FriBidi, bidirectional text | https://github.com/fribidi/fribidi |
| Fontconfig, font lookup | https://gitlab.freedesktop.org/fontconfig/fontconfig |
| Opus, audio encoding | https://gitlab.xiph.org/xiph/opus |
| whisper.cpp, local transcription | https://github.com/ggml-org/whisper.cpp/tree/v1.8.2 |
| NVIDIA codec API headers | https://github.com/FFmpeg/nv-codec-headers |
| Intel oneVPL | https://github.com/intel/libvpl |
| AMD AMF | https://github.com/GPUOpen-LibrariesAndSDKs/AMF |

The libass commit and whisper.cpp version links above resolve entries reported in the bundled Gyan README. The other links identify their upstream projects. A reported version or abbreviated commit still requires its complete source tree, any submodules and any distributor patches to reproduce the relevant library.

## Versions reported by the Gyan 8.0.1 full-build README

This table transcribes the `release-full external libraries' versions` section of the original `FFmpeg-build.txt`. Version strings retain Gyan's spelling, including `latest` for openal-soft and the trailing period in the VAAPI entry. These are distributor-reported versions. This table does not claim that their source archives, patches or build recipes have been collected or independently rebuilt.

| Component | Reported version |
| --- | --- |
| AMF | v1.5.0 |
| aom | v3.13.1-119-g2e124f462b |
| aribb24 | v1.0.3-5-g5e9be27 |
| aribcaption | 1.1.1 |
| AviSynthPlus | v3.7.5-37-gb6d79944 |
| bs2b | 3.1.0 |
| cairo | 1.18.5 |
| chromaprint | 1.6.0 |
| codec2 | 1.2.0-106-g96e8a19c |
| dav1d | 1.5.2-8-ge7c280e |
| davs2 | 1.7-1-gb41cf11 |
| dvdnav | 7.0.0 |
| dvdread | 7.0.1 |
| ffnvcodec | n13.0.19.0-2-g876af32 |
| flite | v2.2-55-g6c9f20d |
| freetype | VER-2-14-1 |
| frei0r | v2.5.0-7-g40a50be |
| fribidi | v1.0.16-2-gb28f43b |
| gsm | 1.0.22 |
| harfbuzz | 12.2.0-18-g3129b36c |
| ladspa-sdk | 1.17 |
| lame | 3.100 |
| lc3 | 1.1.3 |
| lcms2 | 2.16 |
| lensfun | v0.3.95-1836-g71fcb51a |
| libass | 0.17.4-16-ge60dddb |
| libcdio-paranoia | 10.2 |
| libgme | 0.6.4 |
| libilbc | v3.0.4-346-g6adb26d4a4 |
| libjxl | v0.11-snapshot-456-g9174e635 |
| libopencore-amrnb | 0.1.6 |
| libopencore-amrwb | 0.1.6 |
| libplacebo | v7.351.0-90-g2e5a392 |
| libsoxr | 0.1.3 |
| libssh | 0.11.3 |
| libtheora | v1.2.0 |
| libwebp | v1.6.0-123-g2760d87 |
| openal-soft | latest |
| openapv | v0.2.0.4-3-g8d2e357 |
| openmpt | libopenmpt-0.6.25-27-gfcf6687cb |
| opus | v1.5.2-320-g2c0b1187 |
| qrencode | 4.1.1 |
| quirc | 1.2 |
| rav1e | p20250624-1-gb7bf390 |
| rist | 0.2.12 |
| rubberband | v1.8.1 |
| SDL | release-2.32.0-137-gc44d37b5c |
| shaderc | v2025.4-1-g5dcb000 |
| shine | 3.1.1 |
| snappy | 1.2.2 |
| speex | Speex-1.2.1-51-g0589522 |
| srt | v1.5.5-rc.0a-5-gc09532f8 |
| SVT-AV1 | v3.1.0-194-g090bdfba |
| twolame | 0.4.0 |
| uavs3d | v1.1-47-g1fd0491 |
| VAAPI | 2.23.0. |
| vidstab | v1.1.1-20-g4bd81e3 |
| vmaf | v3.0.0-122-ge0d9b82d |
| vo-amrwbenc | 0.1.3 |
| vorbis | v1.3.7-21-g851cce99 |
| VPL | 2.15 |
| vpx | v1.15.2-142-g9a7674e1a |
| vulkan-loader | v1.4.333-2-g655909f |
| vvenc | v1.13.1-201-g45e89ef |
| whisper.cpp | 1.8.2 |
| x264 | v0.165.3223 |
| x265 | 4.1-212-g9e551a994 |
| xavs2 | 1.4 |
| xevd | 0.5.0 |
| xeve | 0.5.1 |
| xvid | v1.3.7 |
| zeromq | 4.3.5 |
| zimg | release-3.0.6-211-gdf9c147 |
| zvbi | v0.2.44-4-g41477c9 |

The `rubberband v1.8.1` entry describes the library embedded in Gyan's FFmpeg. SLU's separate audio-stretch helper uses Rubber Band 4.0.0, with its own source archive, patches and build manifest in this distribution.

## Public build-recipe references

Gyan's GitHub account maintains a fork of media-autobuild_suite containing Windows/MSYS2 build recipes. Its `build/media-suite_compile.sh` provides upstream source locations, static-library build commands and patch references. The inspected script includes unpinned `do_vcs` downloads, `LATEST` selections and a `custom_build_options` hook. The connection between a particular revision of this fork and the released Gyan 8.0.1 binaries remains unverified. [Gyan's build-suite fork](https://github.com/GyanD/media-autobuild_suite), [compile script](https://raw.githubusercontent.com/GyanD/media-autobuild_suite/master/build/media-suite_compile.sh).

Related recipe and patch sources are maintained by the build-suite and MSYS2 projects. Their current branches are discovery references. An exact source package would need the revisions and local modifications used for the 2025-11-20 binary release. [media-autobuild_suite](https://github.com/m-ab-s/media-autobuild_suite), [MABS patch history](https://github.com/m-ab-s/mabs-patches), [MSYS2 MinGW package recipes](https://github.com/msys2/MINGW-packages).

The Gyan 8.0.1 release lists six binary archives and two GitHub-generated source archives of the `codexffmpeg` support repository. The repository tree contains its README and funding metadata. The FFmpeg source reference is separately linked from the release description. No complete external-library source bundle or release-specific build-script bundle was identified in these release assets. [8.0.1 assets](https://github.com/GyanD/codexffmpeg/releases/expanded_assets/8.0.1), [support repository](https://github.com/GyanD/codexffmpeg).

## Remaining source coverage

The package includes upstream FFmpeg source, GPL text, the original Gyan build/configuration records and the reported dependency versions above. Complete sources for the external static libraries and Gyan's release-specific build scripts remain uncollected.

- The README reports `openal-soft latest`, which leaves its exact revision unresolved.
- The enabled-library list contains additional entries without versions in the version table, including bzlib, GMP, GnuTLS, iconv, libbluray, libcaca, libcdio, Fontconfig, libmodplug, libmysofa, libopenjpeg, libxml2, lzma and zlib. Transitive dependencies, patches and toolchain package versions also require identification.
- `FFmpeg-version.txt` reports GCC 15.2.0, MSYS2 Rev8. The full MSYS2 package inventory, build-suite revision, dependency configuration flags, local patches and custom options used for this binary have not been located.
- The confirmed libass commit and whisper.cpp tag links improve source identification. Archive bytes, hashes and complete dependency source trees still need to be collected for a comprehensive source bundle.

Gyan's build page provides the distributor's published contact route and issue tracker for locating the remaining release-specific material. [Gyan build information and notes](https://www.gyan.dev/ffmpeg/builds/).
