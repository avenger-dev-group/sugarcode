#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: pnpm smoke:provider -- PROFILE_ID [PROFILE_ID ...]" >&2
  exit 2
fi

for profile_id in "$@"; do
  echo "live provider smoke: ${profile_id}" >&2
  cargo run --locked -p sugarcode-cli -- exec \
    --model-profile "$profile_id" \
    --json \
    "Reply with exactly SUGARCODE_LIVE_SMOKE_OK"
done
