"""Read-only Linux process references; never publish argv or private paths."""
import os
from pathlib import Path

MAX_ARGV_BYTES = 8 * 1024 * 1024
MAX_ARGV_WORDS = 65536


def process_references(proc=Path('/proc')):
    if not proc.is_dir():
        raise RuntimeError('process-census-unavailable')
    rows = []
    argv_bytes = argv_words = 0
    for count, process in enumerate(proc.iterdir(), 1):
        if count > 8192:
            raise RuntimeError('process-census-over-budget')
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            started = (process / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            with (process / 'cmdline').open('rb') as command:
                raw = command.read(131073)
            argv_bytes += len(raw)
            argv_words += raw.count(b'\0') + 1
            if len(raw) > 131072 or argv_bytes > MAX_ARGV_BYTES or argv_words > MAX_ARGV_WORDS:
                raise RuntimeError('process-argv-over-budget')
            cwd = os.readlink(process / 'cwd')
            exe = os.readlink(process / 'exe').removesuffix(' (deleted)')
            args = raw.decode('utf-8', errors='surrogateescape').split('\0')
            if (process / 'stat').read_text().rsplit(')', 1)[1].split()[19] != started:
                raise RuntimeError('process-identity-changed')
            rows.append((cwd, exe, args))
        except FileNotFoundError:
            continue
        except PermissionError as error:
            raise RuntimeError('process-census-unverifiable') from error
    return rows


def references_root(root, rows):
    text = str(root)
    for cwd, exe, args in rows:
        if any(value == text or value.startswith(text + '/') for value in (cwd, exe)):
            return True
        for argument in args:
            offset = argument.find(text)
            while offset >= 0:
                end = offset + len(text)
                before = argument[offset - 1] if offset else ''
                after = argument[end] if end < len(argument) else ''
                if (not before or before in "=:'\" \t") and (not after or after in "/:'\" \t"):
                    return True
                offset = argument.find(text, offset + 1)
    return False
