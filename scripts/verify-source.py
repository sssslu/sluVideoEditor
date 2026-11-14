"""Verify a frozen source ZIP against current sources, without extracting it.

Run --plan before packaging to inspect the inclusion set. This command never
builds a ZIP, changes sources, or removes files.
"""
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
import argparse
import fnmatch
import hashlib
import json
import stat

ROOT = Path(__file__).resolve().parent.parent
FOLDERS = ['src', 'electron', 'shared', 'native', 'scripts', 'tests', 'docs', 'examples', 'resources/licenses', 'resources/models']
FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'caption-export.html', 'README.md',
         'LICENSE', '.gitignore', 'resources/icon.png', 'resources/icon.ico']


def digest(stream):
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(block)
    return value.hexdigest()


def selected_files(package):
    filters = next(item['filter'] for item in package['build']['extraResources'] if item['to'] == 'licenses')
    result = {name: ROOT / name for name in FILES}
    for folder in FOLDERS:
        for file in sorted((ROOT / folder).rglob('*')):
            if file.is_file() and '__pycache__' not in file.parts:
                if file.is_symlink():
                    raise ValueError(f'Source must not contain a symbolic link: {file}')
                relative = file.relative_to(ROOT / folder).as_posix()
                if folder == 'resources/licenses' and not any(fnmatch.fnmatchcase(relative, item) for item in filters):
                    continue
                result[file.relative_to(ROOT).as_posix()] = file
    if len({name.casefold() for name in result}) != len(result):
        raise ValueError('Case-insensitive source path collision')
    forbidden = [name for name in result if any(part.startswith(('yt-dlp', 'deno-', 'online-tool-', 'online-source-'))
                 or part == 'deno.exe' for part in name.lower().split('/'))]
    if forbidden:
        raise ValueError(f'Obsolete downloader files selected: {forbidden}')
    required = ['electron/tracking.ts', 'electron/tracking-worker.ts', 'electron/tracking-process.ts',
                'electron/enhancement.ts', 'electron/enhancement-hardware.ts', 'tests/enhancement-hardware.test.ts', 'electron/enhancement-process.ts', 'electron/enhancement-install.ts',
                'electron/processed-mux.ts', 'src/EnhancementDialog.tsx', 'src/enhancement-preview.ts',
                'native/enhancement/seedvr_worker.py', 'native/enhancement/tensor_loader.py', 'native/enhancement/backend-manifest.json',
                'native/enhancement/worker-contract.json', 'native/enhancement/requirements-lock.txt',
                'scripts/prepare-enhancement.mjs', 'scripts/e2e-enhancement-ui.mjs',
                'tests/enhancement.test.ts', 'tests/enhancement-pipeline.test.ts', 'tests/enhancement-process.test.ts',
                'tests/enhancement-install.test.ts', 'src/KeyframeEditor.tsx', 'src/keyframe-edits.ts',
                'src/keyframe-editor.css', 'tests/keyframe-editor.test.ts', 'scripts/e2e-keyframe-editor.mjs',
                'src/assets/fonts/GmarketSansTTFMedium.ttf', 'src/assets/fonts/GmarketSansTTFBold.ttf',
                'resources/licenses/GmarketSans-LICENSE.txt', 'resources/licenses/GmarketSans-manifest.json',
                'electron/matting.ts', 'electron/matting-model.ts', 'electron/matting-worker.ts',
                'electron/matting-process.ts', 'electron/matting-encode.ts', 'electron/video-selection.ts',
                'src/CutoutDialog.tsx', 'shared/processing.ts', 'tests/cutout-edit.test.ts',
                'tests/matting-model.test.ts', 'tests/matting-selection.test.ts',
                'scripts/prepare-matting.mjs', 'scripts/build-matting-model.py',
                'scripts/build.mjs', 'scripts/build-receipt.mjs',
                'resources/models/person-matting-rvm.onnx', 'resources/models/person-matting-rvm-bgr.onnx',
                'resources/models/person-matting-rvm-resnet50.onnx', 'resources/models/person-matting-rvm-resnet50-bgr.onnx',
                'resources/licenses/RVM-LICENSE.txt', 'resources/licenses/RVM-provenance.json',
                'electron/project-assets.ts', 'electron/tracking-registry.ts', 'shared/tracking-reconnect.ts',
                'src/TrackingDialog.tsx', 'scripts/e2e-tracking-suite.mjs', 'scripts/e2e-release-evidence.mjs',
                'scripts/e2e-tracking-reconnect.mjs', 'resources/models/object-tracking-vit.onnx',
                'resources/licenses/ViTTrack-provenance.json', 'resources/licenses/ONNXRuntime-binaries.json',
                'electron/stabilization.ts', 'shared/speed.ts', 'native/audio-stretch.cpp',
                'electron/video-frame.ts', 'tests/stabilization-fidelity.test.ts', 'scripts/e2e-stabilization-fidelity.mjs',
                'electron/reverse.ts', 'electron/reverse-frames.ts', 'tests/reverse.test.ts', 'scripts/e2e-reverse.mjs',
                'scripts/benchmark-reverse-gpu.ts', 'scripts/measure-process-memory.ps1',
                'shared/color.ts', 'shared/color-edits.ts', 
                'electron/render-color.ts', 'src/ColorGradeEditor.tsx', 
                'src/preview/color-grade.ts', 
                'tests/color.test.ts', 'scripts/e2e-color.mjs', 
                
                
                'scripts/benchmark-startup.mjs',
                'shared/audio-eq.ts', 'src/AudioEQEditor.tsx', 'src/audio-eq.css', 'src/preview/audio-eq.ts',
                'tests/audio-eq.test.ts', 'scripts/e2e-audio-eq.mjs',
                'shared/audio-continuity.ts', 'src/preview/audio-plan.ts', 'tests/audio-continuity.test.ts',
                'scripts/prepare-eq-continuity.ts', 'scripts/e2e-eq-continuity.mjs',
                'scripts/prepare-packaged-audio.ts', 'scripts/e2e-packaged-audio.mjs',
                'shared/media-clock.ts', 'electron/media-timing.ts', 'electron/audio-preview.ts',
                'electron/video-color.ts', 'electron/video-input.ts', 'electron/freeze-frame.ts', 'src/freeze.ts', 'src/FreezeDialog.tsx',
                'tests/media-clock.test.ts', 'tests/audio-preview.test.ts', 'tests/freeze-frame.test.ts',
                'tests/freeze-edit.test.ts', 'tests/render-clock.test.ts', 'tests/fixtures/media-clock.ts',
                'scripts/e2e-media-clock.mjs', 'scripts/e2e-freeze-frame.mjs',
                'tests/media-alpha.test.ts', 'scripts/e2e-media-alpha.mjs',
                'tests/fixtures/color-range.ts', 'tests/color-range.test.ts', 'scripts/e2e-color-range.mjs',
                'scripts/benchmark-render.mjs',
                'shared/captions.ts', 'src/CaptionWordEditor.tsx', 'src/captions/font.ts',
                'src/captions/layout.ts', 'electron/caption-raster.ts', 'electron/caption-renderer.ts',
                'electron/caption-preload.ts', 'electron/render-captions.ts', 'caption-export.html',
                'resources/licenses/NotoSansKR-manifest.json', 'resources/licenses/NotoEmoji-manifest.json',
                'shared/transitions.ts', 'shared/transition-edits.ts', 'electron/render-transitions.ts',
                'electron/video-range.ts', 'src/TransitionEditor.tsx', 'scripts/e2e-transitions.mjs',
                'electron/render-transition-gpu.ts', 'electron/source-revision.ts', 'electron/project-sources.ts',
                'native/patch-rubberband.mjs', 'scripts/build-audio-stretch.mjs',
                'resources/licenses/RubberBand-SLU-patch.mjs', 'resources/licenses/RubberBand-LICENSE.txt',
                'resources/licenses/rubberband-4.0.0-source.tar.bz2',
                'resources/licenses/audio-stretch-manifest.json',
                'resources/licenses/audio-stretch-toolchain-LICENSES.txt',
                'resources/licenses/audio-stretch-toolchain-manifest.json']
    for name in required:
        if name not in result or not result[name].is_file():
            raise ValueError(f'Required source/notice missing: {name}')
    return result


def verify(archive_path, package, expected):
    checks = []
    with ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        for entry in entries:
            name = entry.filename
            if ('\\' in name or ':' in name or PurePosixPath(name).is_absolute()
                    or '..' in PurePosixPath(name).parts or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError(f'Unsafe source archive member: {name}')
        if len({name.casefold() for name in names}) != len(names):
            raise ValueError('Duplicate or case-insensitive ZIP member collision')
        if set(names) != set(expected):
            raise ValueError(f'ZIP member set differs: missing={sorted(set(expected)-set(names))}, '
                             f'extra={sorted(set(names)-set(expected))}')
        archived_hashes = {}
        for name, file in expected.items():
            if archive.getinfo(name).file_size != file.stat().st_size:
                raise ValueError(f'ZIP file size differs: {name}')
            with archive.open(name) as packaged, file.open('rb') as source:
                archived_hashes[name] = digest(packaged)
                if archived_hashes[name] != digest(source):
                    raise ValueError(f'ZIP SHA256 differs from current source: {name}')
        checks.append(f'{len(names)} exact source members match current bytes and ZIP CRC')
        archived_package = json.loads(archive.read('package.json'))
        if archived_package['version'] != package['version']:
            raise ValueError('Source ZIP package version differs')
        helper = json.loads(archive.read('resources/licenses/audio-stretch-manifest.json'))
        for name in ['native/audio-stretch.cpp', 'native/patch-rubberband.mjs', 'scripts/build-audio-stretch.mjs']:
            if helper.get('recipe', {}).get(name) != archived_hashes[name]:
                raise ValueError(f'Helper provenance recipe is missing or stale: {name}')
        if archived_hashes['native/patch-rubberband.mjs'] != archived_hashes['resources/licenses/RubberBand-SLU-patch.mjs']:
            raise ValueError('Distributed patch differs from the build patch')
        if helper['sourceSha256'] != archived_hashes['resources/licenses/rubberband-4.0.0-source.tar.bz2']:
            raise ValueError('Rubber Band archive differs from helper provenance')
        toolchain = json.loads(archive.read('resources/licenses/audio-stretch-toolchain-manifest.json'))
        if toolchain['licenseFileSha256'] != archived_hashes['resources/licenses/' + toolchain['licenseFile']]:
            raise ValueError('Static toolchain notice digest differs')
        if toolchain['compiler'] != helper['compiler']:
            raise ValueError('Static toolchain notices identify a different compiler')
        for name in ['NotoSansKR', 'NotoEmoji']:
            font = json.loads(archive.read(f'resources/licenses/{name}-manifest.json'))
            if (archived_hashes.get(font['file']) != font['sha256']
                    or archive.getinfo(font['file']).file_size != font['bytes']
                    or archived_hashes.get('resources/licenses/' + font['licenseFile']) != font['licenseSha256']):
                raise ValueError(f'Bundled font/license provenance mismatch: {name}')
        emphasis = json.loads(archive.read('resources/licenses/GmarketSans-manifest.json'))
        if (emphasis['modified'] is not False or len(emphasis['files']) != 2
                or archived_hashes.get('resources/licenses/' + emphasis['licenseFile']) != emphasis['licenseSha256']):
            raise ValueError('Gmarket Sans font/license provenance mismatch')
        for font in emphasis['files']:
            if (archived_hashes.get(font['file']) != font['sha256']
                    or archive.getinfo(font['file']).file_size != font['bytes']):
                raise ValueError('Gmarket Sans face differs from pinned source')
        checks.append('All four caption font assets and their licenses match pinned source hashes')
        enhancement = json.loads(archive.read('native/enhancement/backend-manifest.json'))
        if (enhancement['schemaVersion'] != 1 or enhancement['platform'] != 'win32'
                or enhancement['architecture'] != 'x64'
                or len(enhancement.get('expectedInstalledFilesSha256', '')) != 64):
            raise ValueError('Enhancement manifest has no pinned Windows runtime inventory')
        for notice in enhancement['licenseFiles']:
            filename = 'native/enhancement/licenses/' + notice['filename']
            if (archived_hashes.get(filename) != notice['sha256']
                    or archive.getinfo(filename).file_size != notice['bytes']):
                raise ValueError(f'Enhancement notice mismatch: {filename}')
        if sum(item['bytes'] for item in enhancement['artifacts']) != enhancement['totalDownloadBytes']:
            raise ValueError('Enhancement download inventory total differs')
        checks.append('Enhancement source includes pinned runtime manifest and matching license notices')
        checks.extend(['Transition, source-range, stabilization/speed sources, native helper, upstream source and notices are present',
                       'Helper recipe, patch, upstream source and toolchain notices agree',
                       'Obsolete downloader binaries, source archives and notices are excluded'])
    with archive_path.open('rb') as stream:
        sha = digest(stream)
    return {'version': package['version'], 'archive': str(archive_path), 'sha256': sha,
            'passed': True, 'checks': checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', action='store_true', help='List the selected files without opening or building a ZIP')
    parser.add_argument('archive', nargs='?', help='Default: release/SLU-Studio-<version>-source.zip')
    args = parser.parse_args()
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8-sig'))
    expected = selected_files(package)
    if args.plan:
        print(json.dumps({'version': package['version'], 'files': sorted(expected), 'count': len(expected)}, ensure_ascii=False, indent=2))
        return
    archive = Path(args.archive).resolve() if args.archive else ROOT / 'release' / f"SLU-Studio-{package['version']}-source.zip"
    print(json.dumps(verify(archive, package, expected), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
