#!/usr/bin/env python3
"""Pass workflow inputs as argv data, never shell source."""
import os
from pathlib import Path
import subprocess
import sys

arguments = ['--a', 'out/android-update-fixtures/rc5.apk']
published = os.environ.get('PUBLISHED_VERSION', '')
if published:
    arguments += ['--published-version', published]
else:
    arguments += ['--b', 'out/android-update-fixtures/rc6.apk', '--expected-code', '104236006',
                  '--handoff', 'out/android-update-handoff/handoff.apk']
subprocess.run([sys.executable, str(Path(__file__).with_name('opka-android-update-acceptance.py')),
                *arguments], check=True)
