#!/bin/sh

set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"
exec node scripts/tailscale.mjs
