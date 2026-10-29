#!/usr/bin/env python3
"""Install the pinned Vale release locally, with its upstream SHA-256 check."""
import hashlib
import io
import json
import pathlib
import platform
import tarfile
import urllib.request

root = pathlib.Path(__file__).resolve().parents[1]
release_file = root / 'vendor/vale/release.json'
release = json.loads(release_file.read_text())
system = {'Darwin': 'macOS', 'Linux': 'Linux'}.get(platform.system())
arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': '64-bit'}.get(platform.machine())
if not system or not arch:
    raise SystemExit('Unsupported platform: install Vale manually and set CASCA_VALE_PATH.')
version = release['version'].removeprefix('v')
name = f'vale_{version}_{system}_{arch}.tar.gz'
base = f'https://github.com/vale-cli/vale/releases/download/v{version}/'
checks = urllib.request.urlopen(base + f'vale_{version}_checksums.txt', timeout=30).read().decode()
expected = next(line.split()[0] for line in checks.splitlines() if line.endswith(name))
blob = urllib.request.urlopen(base + name, timeout=60).read()
if hashlib.sha256(blob).hexdigest() != expected:
    raise SystemExit('Vale checksum mismatch; no executable installed.')
with tarfile.open(fileobj=io.BytesIO(blob)) as archive:
    member = next(member for member in archive if pathlib.Path(member.name).name == 'vale')
    target = root / 'vendor/vale/vale'
    target.write_bytes(archive.extractfile(member).read())
    target.chmod(0o755)
print(f'Installed Vale v{version} ({system}/{arch}), checksum verified.')
