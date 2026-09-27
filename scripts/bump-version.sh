#!/usr/bin/env bash
# Sets the release version everywhere it lives: the Rust workspace (the
# daemon and CLI) and the app. They have to match, because a client replaces
# a daemon older than itself.
#
#   scripts/bump-version.sh 0.1.3
set -euo pipefail
version=${1:?usage: scripts/bump-version.sh <version>}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a version: $version" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)

perl -0pi -e 's/(\[workspace\.package\]\nversion = ")[^"]*/${1}'"$version"'/' "$root/Cargo.toml"
(cd "$root" && cargo update --workspace --quiet)
(cd "$root/app" && npm version --no-git-tag-version --allow-same-version "$version" >/dev/null)
"$root/scripts/check-versions.sh"
