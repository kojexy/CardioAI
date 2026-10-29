#!/usr/bin/env python3
"""Install pinned upstream sources and SHA256-verified weights, never patient data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'model-assets'
WORK = Path(os.environ.get('CARDIOAI_WORK') or ROOT / 'work')


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target, expected, attempts=4):
    """Download with resume (.part + HTTP Range) and retries; keep the file only if SHA256 matches."""
    if target.is_file():
        if sha256(target) == expected:
            print('Verified:', target.name, flush=True)
            return
        # A damaged earlier download: keep it aside for inspection and fetch again.
        target.replace(target.with_name(target.name + '.bad'))
        print('Checksum mismatch, downloading again:', target.name, flush=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + '.part')
    print('Downloading:', url, flush=True)
    for attempt in range(1, attempts + 1):
        done = part.stat().st_size if part.is_file() else 0
        request = urllib.request.Request(url, headers={'Range': f'bytes={done}-'} if done else {})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                resumed = done and response.status == 206
                with part.open('ab' if resumed else 'wb') as out:
                    shutil.copyfileobj(response, out, 1024 * 1024)
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 416:  # nothing left to fetch: the .part is complete (or wrong; the hash decides)
                break
            if attempt == attempts:
                raise
        except OSError:
            if attempt == attempts:
                raise
        print(f'Connection lost, retry {attempt} of {attempts - 1}:', target.name, flush=True)
        time.sleep(5 * attempt)
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
                apply_patch(ROOT / 'outputs/ecg-reader/fairseq-python312-compat.patch', staging)
            (staging / marker.name).write_text(json.dumps(source, indent=2))
            staging.replace(target)


def apply_patch(patch_file, folder):
    """Apply a unified diff (-p1) in pure Python, so no `patch` tool is needed (Windows).
    Every context and removed line must match exactly; otherwise nothing is written."""
    lines = patch_file.read_text().splitlines()
    changes, i = {}, 0
    while i < len(lines):
        if lines[i].startswith('+++ '):
            name = lines[i][4:].split('\t')[0]
            name = name[2:] if name.startswith('b/') else name
            hunks = changes.setdefault(name, [])
            i += 1
            while i < len(lines) and lines[i].startswith('@@'):
                start = int(lines[i].split()[1].split(',')[0][1:])
                old, new = [], []
                i += 1
                while i < len(lines) and not lines[i].startswith(('@@', 'diff ', '--- ')):
                    tag, text = lines[i][:1], lines[i][1:]
                    if tag in (' ', ''):
                        old.append(text); new.append(text)
                    elif tag == '-':
                        old.append(text)
                    elif tag == '+':
                        new.append(text)
                    i += 1
                hunks.append((start, old, new))
            continue
        i += 1
    results = {}
    for name, hunks in changes.items():
        target = folder / name
        text = target.read_text()
        source = text.splitlines()
        offset = 0
        for start, old, new in hunks:
            at = start - 1 + offset
            if source[at:at + len(old)] != old:
                raise ValueError(f'Patch does not match {name} near line {start}')
            source[at:at + len(old)] = new
            offset += len(new) - len(old)
        results[target] = '\n'.join(source) + ('\n' if text.endswith('\n') else '')
    for target, text in results.items():
        target.write_text(text)


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
