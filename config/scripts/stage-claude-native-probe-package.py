"""Stage one verified official native CLI artifact without running install scripts."""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import sys
import tarfile
import urllib.parse
import urllib.request

if os.environ.get('OPKA_ISOLATED_AUDIT_CACHE') != '1':
    raise SystemExit('An isolated audit cache is required')
metadata = json.loads(pathlib.Path(sys.argv[1]).read_text())
base = metadata['base']
native = metadata['native']
version = native['version']
if version != '2.1.318' or base['version'] != version or base['optionalDependencies'].get(native['name']) != version or native['dist']['unpackedSize'] > 768 * 1024 * 1024:
    raise SystemExit('Only the approved official 2.1.318 candidate may be staged')
url = native['dist']['tarball']
if urllib.parse.urlsplit(url).scheme != 'https' or urllib.parse.urlsplit(url).hostname != 'registry.npmjs.org':
    raise SystemExit('Expected the official npm registry archive')
cache = pathlib.Path(sys.argv[2]).resolve()
cache.mkdir(mode=0o700, parents=False, exist_ok=False)
archive = cache / 'official-native.tgz'
hashes = {algorithm: hashlib.new(algorithm) for algorithm in ('sha1', 'sha256', 'sha512')}
size = 0
with urllib.request.urlopen(url, timeout=45) as response, archive.open('xb') as target:
    while chunk := response.read(1024 * 1024):
        size += len(chunk)
        if size > 512 * 1024 * 1024:
            raise SystemExit('Candidate archive exceeds the bounded audit budget')
        target.write(chunk)
        for digest in hashes.values():
            digest.update(chunk)
        if size % (16 * 1024 * 1024) == 0:
            print(json.dumps({'downloadedMiB': size // (1024 * 1024)}), flush=True)
expected = native['dist']['integrity'].removeprefix('sha512-')
if base64.b64encode(hashes['sha512'].digest()).decode() != expected or hashes['sha1'].hexdigest() != native['dist']['shasum']:
    raise SystemExit('Official registry archive integrity verification failed')
unpacked = cache / 'unpacked'
unpacked.mkdir(mode=0o700)
files = []
with tarfile.open(archive, 'r:gz') as package:
    members = package.getmembers()
    if sum(member.size for member in members) != native['dist']['unpackedSize']:
        raise SystemExit('Archive size differs from the registry manifest')
    for member in members:
        relative = pathlib.PurePosixPath(member.name)
        if relative.is_absolute() or '..' in relative.parts or relative.parts[0] != 'package' or not (member.isdir() or member.isfile()):
            raise SystemExit('Unsafe package archive member')
        destination = unpacked.joinpath(*relative.parts)
        if member.isdir():
            destination.mkdir(parents=True, mode=0o700, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        with package.extractfile(member) as source, destination.open('xb') as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        destination.chmod(member.mode & 0o777)
        files.append(destination)
executables = [path for path in files if path.name in ('claude', 'claude.exe')]
if len(executables) != 1:
    raise SystemExit('Expected exactly one native Claude executable')
executable = executables[0]
with executable.open('rb') as source:
    magic = source.read(4)
    darwin = native['name'] in ('@anthropic-ai/claude-code-darwin-arm64', '@anthropic-ai/claude-code-darwin-x64')
    linux = native['name'] in ('@anthropic-ai/claude-code-linux-x64', '@anthropic-ai/claude-code-linux-arm64')
    if not ((linux and magic == b'\x7fELF') or (darwin and magic.hex() in ('cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'))):
        raise SystemExit('Expected the approved official platform executable')
    source.seek(0)
    executable_digest = hashlib.sha256()
    while chunk := source.read(1024 * 1024):
        executable_digest.update(chunk)
    executable_hash = executable_digest.hexdigest()
receipt = {'version': version, 'package': native['name'], 'registryIntegrityVerified': True, 'archiveBytes': size, 'archiveSha256': hashes['sha256'].hexdigest(), 'executable': str(executable), 'executableSha256': executable_hash, 'unpackedBytes': native['dist']['unpackedSize'], 'fileCount': len(files), 'noInstallerExecuted': True}
(cache / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt), flush=True)
