#!/usr/bin/env bash
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then exit 78; fi
case "${1-}" in linux-x64|darwin-arm64) ;; *) exit 78 ;; esac
: "${RUNNER_TEMP:?Runner temporary directory required}"

work="$RUNNER_TEMP/opka-replay-ci"
mkdir -p "$work/modules" "$work/go" "$work/source" out/native-transport
if [ ! -f "$work/source.tar.gz" ]; then
  curl --connect-timeout 10 --max-time 300 -fsSL \
    'https://codeload.github.com/router-for-me/CLIProxyAPI/tar.gz/e6e5708e677adb2463d45accdd24bc9fd028ddd8' \
    -o "$work/source.tar.gz"
fi
if [ ! -f "$work/go.tar.gz" ]; then
  curl --connect-timeout 10 --max-time 300 -fsSL \
    'https://go.dev/dl/go1.26.10.linux-amd64.tar.gz' -o "$work/go.tar.gz"
fi
printf '%s  %s\n' \
  '45d766358b7e6c453031800af6f1ba6fa1a30bf06a9aca9de8e39141aeaf5b56' "$work/source.tar.gz" \
  'ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5' "$work/go.tar.gz" \
  | sha256sum -c -

tar -xf "$work/go.tar.gz" -C "$work/go" --strip-components=1
tar -xf "$work/source.tar.gz" -C "$work/source" --strip-components=1
(cd "$work/source" && GOMODCACHE="$work/modules" \
  timeout --signal=TERM --kill-after=10s 600s "$work/go/bin/go" mod download)
GOMODCACHE="$work/modules" timeout --signal=TERM --kill-after=10s 1080s \
  node config/scripts/build-codex-replay-engine.mjs "$1" \
  "$work/source.tar.gz" "$work/go.tar.gz" "$PWD/.build/codex-routing-replay"
