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
# checkout puts the ephemeral one today. Decision lines are the log.
#
# Local/dev or test invocation: PATH-shim `doppler`/`curl` (see
# tests/resolve-push-token.test.mjs); GIT_BIN and a cwd that is a git
# repository are required.
set -euo pipefail

PROJECT="${DOPPLER_PROJECT:-seed}"
CONFIG="${DOPPLER_CONFIG:-prd}"

# Caller-provided last resort. Required: an empty push credential is a
# broken job, not a degraded one — fail loud, never silently unauthenticated.
FALLBACK="${PUSH_FALLBACK_CRED:?no fallback credential supplied (expected secrets.DSH_BOT_REPO_TOKEN || github.token)}"

GIT_BIN="${GIT_BIN:-git}"
# Test seam only — callers never set it. An explicit path lets the offline
# suite construct "no doppler on this runner": the dsh lanes install the
# real CLI in a system dir, so PATH restriction alone cannot hide it.
DOPPLER_BIN="${DOPPLER_BIN:-doppler}"

write_header() { # $1 = token value; base64 may wrap (BSD, 76 cols) — strip newlines
  "$GIT_BIN" config --local http.https://github.com/.extraheader \
    "AUTHORIZATION: basic $(printf 'x-access-token:%s' "$1" | base64 | tr -d '\n')"
}

if [ -z "${DOPPLER_SERVICE_TOKEN:-}" ] || ! command -v "$DOPPLER_BIN" >/dev/null 2>&1; then
  echo "push-token: workflow secret fallback (no doppler cli/service token on this runner)"
  write_header "$FALLBACK"; exit 0
fi

TOK="$("$DOPPLER_BIN" secrets get GITHUB_TOKEN --project "$PROJECT" --config "$CONFIG" --plain 2>/dev/null)" || {
  echo "push-token: workflow secret fallback (doppler fetch failed)"
  write_header "$FALLBACK"; exit 0
}
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
