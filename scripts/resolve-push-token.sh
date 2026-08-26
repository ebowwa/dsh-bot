#!/usr/bin/env bash
# resolve-push-token.sh — Doppler-first git push credential for agent jobs.
#
# Why this exists: actions/checkout persists the ephemeral GITHUB_TOKEN as
# an http.<url>.extraheader in the job workspace's local git config, and
# every `git push` the agent (or the deterministic shipper) makes rides it.
# That identity is github-actions[bot], which hits two walls GitHub will
# never lift for it:
#   1. the ephemeral token can NEVER carry `workflows` permission — a push
#      whose commits edit .github/workflows/** is rejected outright
#      ("refusing to allow a GitHub App to create or update workflow ..."),
#      the same wall dsh-bot-bump.yml documents for its own push;
#   2. even for non-workflow commits, a bot-identity push onto a PR whose
#      OVERALL diff touches workflow files parks every triggered run in
#      action_required until a human approves (observed 2026-08-26: factory
#      PR #229 — gates runs 32921795436 and 32924697952 created, never
#      executed, while the human-actor push on the same PR ran green).
#
# Fix: run AFTER the main checkout (which must set persist-credentials:
# false) and BEFORE the agent, rewriting the extraheader with a
# workflows-capable PAT. Source order — owner directive 2026-08-25: the
# factory's git tokens live in Doppler (seed/prd GITHUB_TOKEN):
#   1. Doppler seed/prd GITHUB_TOKEN — ONLY if its scopes cover
#      repo + workflow (probe = one x-oauth-scopes header read);
#   2. the caller-supplied fallback (secrets.DSH_BOT_REPO_TOKEN || github.token
#      at the call sites — the bump workflow documents DSH_BOT_REPO_TOKEN
#      as a PAT with workflow scope; github.token reproduces today's
#      behavior exactly, so the wiring is never WORSE than before).
#
# Env names deliberately avoid the KEY/PASSWORD/SECRET/TOKEN patterns
# (dsh scrubs those from agent child processes) even though this step's
# env never reaches the agent. The token VALUE is never printed, logged,
# or written anywhere except the local git config — the same place the
# checkout puts the ephemeral one today — and it never rides argv: it
# reaches the config file via a bash-builtin printf redirect, so no
# spawned process ever lists it on its command line (argv is ps/
# /proc/<pid>/cmdline readable by any concurrent job under the same
# runner service account; actions/checkout keeps its credential out of
# argv for the same reason). Decision lines are the log.
#
# Local/dev or test invocation: PATH-shim `doppler`/`curl` (see
# tests/resolve-push-token.test.mjs — including a fully hermetic PATH
# that constructs "no doppler on this runner" without depending on the
# lane image); GIT_BIN (the one seam, same as before — the offline suite
# points it at an argv-observing shim) and a cwd that is a git
# repository are required.
set -euo pipefail

PROJECT="${DOPPLER_PROJECT:-seed}"
CONFIG="${DOPPLER_CONFIG:-prd}"

# Caller-provided last resort. Required: an empty push credential is a
# broken job, not a degraded one — fail loud, never silently unauthenticated.
FALLBACK="${PUSH_FALLBACK_CRED:?no fallback credential supplied (expected secrets.DSH_BOT_REPO_TOKEN || github.token)}"

GIT_BIN="${GIT_BIN:-git}"
# Bound on a hung doppler fetch, in seconds (review round-1 finding 4:
# the curl probe was already bounded, the fetch was not — a hung Doppler
# API held the job until the workflow-level timeout). GNU `timeout` is
# absent on the mac cells, so the bound is a background fetch + watchdog.
FETCH_TIMEOUT_S="${DOPPLER_FETCH_TIMEOUT_S:-20}"

write_header() { # $1 = token value; base64 may wrap (BSD, 76 cols) — strip newlines
  # Idempotency first: drop any prior stanza. argv carries only the KEY;
  # exit 5 ("no such key") on a fresh checkout is expected, not an error,
  # and the appended stanza plus every push that follows re-verifies it.
  "$GIT_BIN" config --local --unset-all http.https://github.com/.extraheader 2>/dev/null || true
  # Append the stanza to .git/config directly: printf is a bash builtin
  # and the value is a %s ARGUMENT (never part of the format, never an
  # argument of a spawned process), so the credential stays off argv.
  # base64 (+, /, =) and the AUTHORIZATION prefix contain no quote or
  # backslash characters, so the double-quoted git-config value is exact.
  printf '[http "https://github.com/"]\n\textraheader = "%s"\n' \
    "AUTHORIZATION: basic $(printf 'x-access-token:%s' "$1" | base64 | tr -d '\n')" \
    >> "$("$GIT_BIN" rev-parse --git-dir)/config"
}

if [ -z "${DOPPLER_SERVICE_TOKEN:-}" ] || ! command -v doppler >/dev/null 2>&1; then
  echo "push-token: workflow secret fallback (no doppler cli/service token on this runner)"
  write_header "$FALLBACK"; exit 0
fi

# Bounded doppler fetch — parity with the --max-time 15 probe below: a
# hung Doppler API must not hold the job. The fetch runs backgrounded
# with a watchdog (no GNU `timeout` on the mac cells); a watchdog kill
# surfaces through the same typed fallback as every doppler-side
# failure. The token value's only resting place besides the git config
# is a 0600 mktemp file, read once and removed on both branches.
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/resolve-push-token.XXXXXX")"
FETCH_PID='' WATCHDOG_PID=''
reap_watchdog() { # stop the timer once the fetch answered (quiet, idempotent)
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
}
doppler secrets get GITHUB_TOKEN --project "$PROJECT" --config "$CONFIG" --plain \
  >"$OUT_FILE" 2>/dev/null &
FETCH_PID=$!
# The watchdog is detached from our stdio (>/dev/null 2>&1 </dev/null):
# an inherited stdout pipe would hold every caller waiting on it (CI log
# collectors, spawn-based callers) until the timer expires, even after
# this script has exited — the orphaned `sleep` keeps the pipe open.
( sleep "$FETCH_TIMEOUT_S" && kill "$FETCH_PID" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
WATCHDOG_PID=$!
FETCH_OK=0
if wait "$FETCH_PID"; then FETCH_OK=1; fi
reap_watchdog
if [ "$FETCH_OK" -ne 1 ]; then
  rm -f "$OUT_FILE"
  echo "push-token: workflow secret fallback (doppler fetch failed)"
  write_header "$FALLBACK"; exit 0
fi
TOK="$(cat "$OUT_FILE")"
rm -f "$OUT_FILE"
if [ -z "$TOK" ]; then
  echo "push-token: workflow secret fallback (doppler $PROJECT/$CONFIG has no GITHUB_TOKEN)"
  write_header "$FALLBACK"; exit 0
fi

# Bounded probe (--max-time 15): a hung api.github.com must not hold the
# job; a failed probe falls back like every doppler-side failure.
SCOPES="$(curl -sI --max-time 15 -H "Authorization: token $TOK" https://api.github.com/user \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="x-oauth-scopes" {print $2}')" \
  || { echo "push-token: workflow secret fallback (scope probe failed — no answer from api.github.com)"; write_header "$FALLBACK"; exit 0; }
if [ -z "$SCOPES" ]; then
  echo "push-token: workflow secret fallback (scope probe returned nothing — token invalid?)"
  write_header "$FALLBACK"; exit 0
fi

# Comma list → padded space list so fixed-string matching is exact per scope.
SCOPES_SP=" ${SCOPES//,/ } "
MISSING=""
for s in repo workflow; do
  case "$SCOPES_SP" in
    *" $s "*) ;;
    *) MISSING="$MISSING $s" ;;
  esac
done
if [ -n "$MISSING" ]; then
  echo "push-token: workflow secret fallback (doppler $PROJECT/$CONFIG GITHUB_TOKEN lacks:$MISSING)"
  write_header "$FALLBACK"; exit 0
fi

write_header "$TOK"
echo "push-token: doppler $PROJECT/$CONFIG (scopes ok)"
