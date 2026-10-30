#!/usr/bin/env python3
"""Sign an APK with the user's separate Opka key; retrieve its password in memory."""
import argparse
import ctypes
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--apksigner', required=True)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Local Keychain signing requires macOS; CI uses its protected signing environment')
    store = Path.home() / '.opka-signing' / 'android-beta.jks'
    if not store.is_file() or store.stat().st_mode & 0o077:
        parser.error('The user-owned Android signing store must exist with mode 0600')
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    security.SecKeychainFindGenericPassword.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p,
        ctypes.c_uint32, ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    service = b'io.github.kosfin.opka.android-signing'
    account = b'android-beta'
    size = ctypes.c_uint32()
    data = ctypes.c_void_p()
    result = security.SecKeychainFindGenericPassword(None, len(service), service, len(account), account,
        ctypes.byref(size), ctypes.byref(data), None)
    if result != 0:
        raise SystemExit(f'Could not read the Opka signing password from Keychain ({result})')
    try:
        password = ctypes.string_at(data, size.value).decode()
    finally:
        security.SecKeychainItemFreeContent(None, data)
    env = {**os.environ, 'OPKA_ANDROID_KEYSTORE_PASSWORD': password}
    subprocess.run([args.apksigner, 'sign', '--ks', str(store), '--ks-key-alias', 'opka-beta',
        '--ks-pass', 'env:OPKA_ANDROID_KEYSTORE_PASSWORD', '--key-pass', 'env:OPKA_ANDROID_KEYSTORE_PASSWORD',
        '--out', args.output, args.input], env=env, check=True)
    subprocess.run([args.apksigner, 'verify', '--verbose', '--print-certs', args.output], check=True)


if __name__ == '__main__':
    main()
