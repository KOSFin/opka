#!/bin/zsh
set -eu
test_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_node="$test_root/.tmp/iteration-001/toolchain/node-v24.21.0-darwin-arm64/bin/node"
if [ ! -x "$test_node" ]; then
  test_node="$(command -v node)"
fi
exec "$test_node" "$test_root/config/scripts/fork-acceptance.mjs" --open
