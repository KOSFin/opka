#!/usr/bin/env python3
"""Build the CI-only instrumentation APK; signing remains in the existing CI key scope."""
import os
from pathlib import Path
import subprocess
import zipfile


def main():
    root = Path(__file__).resolve().parents[2]
    sdk = Path(os.environ['ANDROID_HOME'])
    tools = sdk / 'build-tools' / '36.0.0'
    android = sdk / 'platforms' / 'android-36' / 'android.jar'
    output = root / 'out' / 'android-update-handoff'
    classes = output / 'classes'
    dex = output / 'dex'
    classes.mkdir(parents=True, exist_ok=True)
    dex.mkdir(parents=True, exist_ok=True)
    source = root / 'config' / 'android-update-handoff'
    subprocess.run(['javac', '-source', '8', '-target', '8', '-classpath', str(android),
                    '-d', str(classes), str(source / 'UpdateHandoffInstrumentation.java')], check=True)
    subprocess.run([str(tools / 'd8'), '--lib', str(android), '--min-api', '24',
                    '--output', str(dex), *map(str, classes.rglob('*.class'))], check=True)
    apk = output / 'handoff-unsigned.apk'
    subprocess.run([str(tools / 'aapt2'), 'link', '--manifest', str(source / 'AndroidManifest.xml'),
                    '-I', str(android), '-o', str(apk)], check=True)
    with zipfile.ZipFile(apk, 'a') as archive:
        archive.write(dex / 'classes.dex', 'classes.dex')
    subprocess.run([str(tools / 'zipalign'), '-f', '4', str(apk),
                    str(output / 'handoff-aligned.apk')], check=True)
    subprocess.run([str(tools / 'zipalign'), '-c', '4',
                    str(output / 'handoff-aligned.apk')], check=True)


if __name__ == '__main__':
    main()
