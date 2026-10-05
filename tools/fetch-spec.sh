#!/usr/bin/env bash
# Refresh the vendored API description from the live service.
#
# The OpenAPI document and the WebSocket reference are the only sources of truth for the generated
# layer, so they are vendored: a build must not depend on the network, and `git diff` after a
# refresh shows exactly how the API changed.
#
# Both files, the TikTok gift tables and the caveats collected while writing these clients live in
# https://github.com/Bluscream/synchra-api — including tools/diff-spec.sh, which turns a refresh
# into a list of what moved and fails when a route was *removed*.
set -euo pipefail

host="${SYNCHRA_API_HOST:-https://api.synchra.net}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# GitHub's Contents API rather than raw.githubusercontent.com, which is behind a CDN that serves a
# stale copy for several minutes after a push — long enough that a refresh right after an overlay
# change silently applies the previous version. `Accept: application/vnd.github.raw` returns the
# file itself. Unauthenticated it is rate-limited to 60 requests an hour, ample for a manual
# refresh; set SYNCHRA_OVERLAY_SOURCE to a raw url or a local file:// url to override.
OVERLAY_SOURCE="${SYNCHRA_OVERLAY_SOURCE:-https://api.github.com/repos/Bluscream/synchra-api/contents/overlay/annotations.json?ref=main}"

# Normalised with `jq --sort-keys`, which the PHP client deliberately does not do.
#
# There, key order leaks into the generated API: an inline enum is named after the first property
# that references it, and constructor parameters follow property order, so sorting renames classes
# and reorders 290 constructors. This generator has neither property — inline enums become inline
# literal unions with no name at all, every method takes one options object rather than positional
# arguments, and the emitter sorts what it writes. test/generator.test.ts asserts that by generating
# from the document and from a key-sorted copy of it and comparing the output, so the claim is
# checked rather than asserted.
#
# Sorting is worth having: the API does not promise a stable key order, and without normalising,
# two fetches of an *unchanged* document produce a diff thousands of lines long.
#
# jq rather than a Node round-trip, which is lossy in a way that would stop this script reproducing
# the file it committed: the description writes some bounds as `60.0`, and JSON.parse/stringify
# rewrites that as `60`.
overlay="$root/spec/annotations.json"

if [[ "${1:-}" == --refresh-overlay || ! -f "$overlay" ]]; then
    echo "Fetching the annotation overlay from $OVERLAY_SOURCE"
    curl --fail --show-error --silent \
        --header 'Accept: application/vnd.github.raw' \
        "$OVERLAY_SOURCE" >"$overlay.new"

    # It must at least parse, or the jq run below fails with something far less obvious.
    jq empty "$overlay.new"
    mv -f "$overlay.new" "$overlay"
fi

# Written to a temporary file and moved into place, so a failure — a note whose target the
# description no longer has, which annotate.jq treats as fatal — leaves the committed description
# untouched instead of truncating it. `set -o pipefail` is what makes that failure reach here.
curl --fail --show-error --silent "$host/openapi.json" |
    jq --sort-keys --argjson overlay "$(cat "$overlay")" --from-file "$root/tools/annotate.jq" \
        >"$root/spec/openapi.json.new"

mv -f "$root/spec/openapi.json.new" "$root/spec/openapi.json"

curl --fail --show-error --silent "$host/api/2/ws-docs" >"$root/spec/websocket.md"

echo "Fetched $host into spec/. Run 'npm run generate' to rebuild the generated layer."
