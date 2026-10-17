#!/usr/bin/env bash
# Upload files to a GitHub release, retrying while GitHub does not find it yet.
#
#   scripts/upload-release-assets.sh <tag> <file>...
#
# The phone jobs run after the desktop jobs have published the release, yet on
# v0.14.0 the iPhone job got "release not found" four minutes after the release
# was published, and a plain re-run then worked. So each upload is retried with
# a growing pause (about eight minutes in all) before the job is failed.
# Requires GH_TOKEN; uses GITHUB_REPOSITORY when set, so gh never has to guess
# the repository from the checkout.
set -euo pipefail

tag="${1:?usage: upload-release-assets.sh <tag> <file>...}"
shift
[ "$#" -gt 0 ] || { echo "no files to upload" >&2; exit 1; }
for f in "$@"; do
  [ -f "$f" ] || { echo "not a file: $f" >&2; exit 1; }
done

repo=()
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  repo=(--repo "$GITHUB_REPOSITORY")
fi

attempts="${UPLOAD_ATTEMPTS:-8}"
pause="${UPLOAD_FIRST_PAUSE:-10}"
for ((i = 1; i <= attempts; i++)); do
  # The ${a[@]+...} form keeps macOS's bash 3.2 happy with an empty array under set -u.
  if gh release upload "$tag" "$@" --clobber ${repo[@]+"${repo[@]}"}; then
    echo "uploaded to $tag: $*"
    exit 0
  fi
  if ((i == attempts)); then
    break
  fi
  echo "upload to $tag failed (attempt $i of $attempts); trying again in ${pause}s" >&2
  sleep "$pause"
  pause=$((pause * 2 > 120 ? 120 : pause * 2))
done
echo "could not upload to $tag after $attempts attempts" >&2
exit 1
