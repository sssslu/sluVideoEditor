from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, fnmatch
root = Path(__file__).resolve().parent.parent
package = json.loads((root / 'package.json').read_text(encoding='utf8'))
version = package['version']
license_filters = next(item['filter'] for item in package['build']['extraResources'] if item['to']=='licenses')
out = root / 'release' / f'SLU-Studio-{version}-source.zip'
folders = ['src', 'electron', 'shared', 'native', 'scripts', 'tests', 'docs', 'examples', 'resources/licenses', 'resources/models']
files = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'caption-export.html', 'README.md', 'LICENSE', '.gitignore', 'resources/icon.png', 'resources/icon.ico']
with ZipFile(out, 'w', compression=ZIP_DEFLATED, compresslevel=6) as archive:
    for name in files:
        archive.write(root / name, name)
    for folder in folders:
        for item in sorted((root / folder).rglob('*')):
            if item.is_file() and '__pycache__' not in item.parts:
                if folder == 'resources/licenses' and not any(fnmatch.fnmatchcase(item.relative_to(root/folder).as_posix(),pattern) for pattern in license_filters):
                    continue
                archive.write(item, item.relative_to(root).as_posix())
print(out)
