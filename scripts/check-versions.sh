#!/usr/bin/env bash
# Checks that the Rust workspace and the app have the same version, and on a
# release tag (v1.2.3 in $GITHUB_REF_NAME or the first argument) that it's
# the tag's. scripts/bump-version.sh sets them all.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
rust=$(perl -0ne 'print $1 if /\[workspace\.package\]\nversion = "([^"]*)"/' "$root/Cargo.toml")
app=$(node -p "require('$root/app/package.json').version")
tag=${1:-${GITHUB_REF_NAME:-}}

if [[ $rust != "$app" ]]; then
  echo "The Rust workspace is $rust but the app is $app; run scripts/bump-version.sh" >&2
  exit 1
fi
if [[ $tag == v* && ${tag#v} != "$rust" ]]; then
  echo "The tag is $tag but the version is $rust; run scripts/bump-version.sh ${tag#v}" >&2
  exit 1
fi
echo "Version $rust"
