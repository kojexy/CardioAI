#!/usr/bin/env python3
"""Install pinned upstream sources and SHA256-verified weights, never patient data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'model-assets'
WORK = ROOT / 'work'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target, expected):
    if target.is_file() and sha256(target) == expected:
        print('Verified:', target.name, flush=True)
        return
    if target.exists():
        raise ValueError('Existing asset has an unexpected checksum: ' + str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + '.part')
    print('Downloading:', url, flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, part.open('wb') as out:
        shutil.copyfileobj(response, out, 1024 * 1024)
    if sha256(part) != expected:
        part.unlink()
        raise ValueError('Downloaded asset SHA256 mismatch: ' + target.name)
    part.replace(target)


def sources():
    config = json.loads((ASSETS / 'sources.json').read_text())
    for source in config['sources']:
        target = WORK / source['folder']
        marker = target / '.cardioai-source.json'
        if target.exists():
            if marker.is_file() and json.loads(marker.read_text()) == source:
                print('Pinned source already installed:', target.name)
                continue
            raise ValueError('Source directory already exists without matching install marker: ' + str(target))
        url = f"https://codeload.github.com/{source['repo']}/tar.gz/{source['revision']}"
        with tempfile.TemporaryDirectory(dir=WORK) as temp:
            temp = Path(temp)
            archive = temp / 'source.tar.gz'
            download(url, archive, source['archive_sha256'])
            staging = temp / 'source'
            staging.mkdir()
            with tarfile.open(archive) as tar:
                for member in tar:
                    if not member.isfile():
                        continue
                    relative = Path(*Path(member.name).parts[1:])
                    if not relative.parts or relative.is_absolute() or '..' in relative.parts:
                        raise ValueError('Unsafe archive member')
                    out = staging / relative
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(tar.extractfile(member).read())
            if source['folder'] == 'fairseq-signals':
                subprocess.run(['patch', '--batch', '-p1', '-i', str(ROOT / 'outputs/ecg-reader/fairseq-python312-compat.patch')], cwd=staging, check=True)
            (staging / marker.name).write_text(json.dumps(source, indent=2))
            staging.replace(target)


def weights():
    for path in sorted(ASSETS.glob('*.pt*.json')):
        meta = json.loads(path.read_text())
        name = meta.get('file', meta.get('filename'))
        folder = 'ecgfounder-weights' if name.endswith('.pth') else 'deepecg-weights'
        target = WORK / folder / name
        url = f"https://huggingface.co/{meta['repo']}/resolve/{meta['revision']}/{name}"
        download(url, target, meta['sha256'])
        expected_size = meta.get('size_bytes', meta.get('size'))
        if target.stat().st_size != expected_size:
            raise ValueError('Weight size mismatch: ' + name)
        shutil.copyfile(path, target.with_name(name + '.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources-only', action='store_true')
    args = parser.parse_args()
    WORK.mkdir(exist_ok=True)
    sources()
    if not args.sources_only:
        weights()
    print('Setup complete. Upstream code and weights retain their original licenses.')


if __name__ == '__main__':
    main()
