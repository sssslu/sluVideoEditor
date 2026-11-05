"""Compatibility entry point; the canonical icon is src/assets/studio-icon.svg."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parent.parent
raise SystemExit(subprocess.call(['node', str(root / 'scripts' / 'make-icon.mjs')], cwd=root))
