#!/usr/bin/env bash
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then exit 78; fi

test "$#" -eq 4
test "$1" = '--inside'
links=(/sys/class/net/*)
test "${#links[@]}" -eq 1 && test "${links[0]##*/}" = lo
while read -r interface _; do
  test "$interface" = Iface || test "$interface" = lo || exit 78
done < /proc/net/route

codex_program="$2"
engine_program="$3"
report_path="$4"
case "$codex_program:$engine_program:$report_path" in
  /*:/*:/*) ;;
  *) exit 78 ;;
esac
test -f "$codex_program" && test -f "$engine_program"
node_program=$(command -v node)
case "$node_program" in /*) ;; *) exit 78 ;; esac

sandbox=$(mktemp -d /tmp/opka-public-compact-ci-XXXXXXXX)
trap 'rm -rf "$sandbox"' EXIT
mkdir -m 700 "$sandbox/home" "$sandbox/codex" "$sandbox/config" \
  "$sandbox/cache" "$sandbox/data" "$sandbox/runtime" "$sandbox/tmp"
env -i \
  PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 CI=1 ORCA_BACKGROUND_LAUNCH=1 \
  HOME="$sandbox/home" CODEX_HOME="$sandbox/codex" \
  XDG_CONFIG_HOME="$sandbox/config" XDG_CACHE_HOME="$sandbox/cache" \
  XDG_DATA_HOME="$sandbox/data" XDG_RUNTIME_DIR="$sandbox/runtime" \
  TMPDIR="$sandbox/tmp" NODE_OPTIONS=--max-old-space-size=1536 \
  GOMEMLIMIT=2048MiB GOMAXPROCS=1 \
  timeout --signal=TERM --kill-after=5s 120s \
  "$node_program" config/scripts/codex-routing-transport-probe.mjs \
    --codex "$codex_program" --engine "$engine_program" \
    --engine-explicit --compact-resume --output "$report_path"
