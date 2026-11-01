#!/usr/bin/env python3
"""Pass workflow inputs as argv data, never shell source."""
import os
from pathlib import Path
import subprocess
import sys
from opka_android_published_update import version_code

arguments = ['--a', 'out/android-update-fixtures/rc5.apk']
published = os.environ.get('PUBLISHED_VERSION', '')
if published:
    arguments += ['--published-version', published,
                  '--surface', os.environ.get('UPDATE_SURFACE', 'settings')]
else:
    candidate = os.environ.get('CANDIDATE_VERSION', '1.4.236-rc.6')
    arguments += ['--b', 'out/android-update-fixtures/candidate.apk', '--expected-code', str(version_code(candidate)),
                  '--handoff', 'out/android-update-handoff/handoff.apk']
subprocess.run([sys.executable, str(Path(__file__).with_name('opka-android-update-acceptance.py')),
                *arguments], check=True)
