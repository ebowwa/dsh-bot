#!/usr/bin/env bash
# post-reply.sh — post (or PATCH) the agent's final answer on the thread,
# shared by the comment workflow (agent-comment.yml) and the out-of-band
# worker (dsh-worker.sh).
#
# Composes the reply (header + scrubbed agent output + ship note), then:
#   - if ACK_COMMENT_ID is set: PATCH that comment in place (the
#     "one living comment per task" UX — the ack comment carries the whole
#     arc: started → shipping → final);
#   - else post a fresh comment on the thread (pr or issue).
#
# Everything user-facing is scrubbed fail-closed: if the scrubber cannot
# run, the answer is withheld, never posted raw.
#
# Env contract:
#   GH_TOKEN            required — comment write access (BOT_PAT in the
#                       workflow; the worker's own PAT in decoupled mode)
#   DSH_SHIP_REPO       repo to comment in (default $GITHUB_REPOSITORY)
#   TARGET_KIND         "pr" | "issue" — which gh ... comment subcommand
#   TARGET_NUM          the issue/PR number
#   DSH_BOT_DIR         dsh-bot toolkit checkout (contains scripts/)
#   DSH_RUN_ID          run identifier for the reply header
#                       (default $GITHUB_RUN_ID)
#   DSH_RUNNER_NAME     lane/worker name for the header
#   DSH_AGENT_OUTPUT    the agent's raw output file
#                       (default $DSH_SHIP_CACHE/dsh-agent-output.txt)
#   DSH_SHIP_NOTE       the ship note text (default: read
#                       $DSH_SHIP_CACHE/dsh-ship-note.txt when present)
#   DSH_REPLY_OUT       where the composed reply is written
#                       (default $DSH_SHIP_CACHE/dsh-reply.md)
#   DSH_SHIP_CACHE      cache dir holding the agent output + ship note
#                       (default ${RUNNER_TEMP:-/tmp})
#   ACK_COMMENT_ID      optional: the ack comment to PATCH instead of posting
#   EXTRA_SCRUB_HOSTS   optional comma-separated hosts for the scrubber
#                       (mapped to DSH_SCRUB_EXTRA_HOSTS like the driver)

set -euo pipefail

DSH_SHIP_REPO="${DSH_SHIP_REPO:-${GITHUB_REPOSITORY:?post-reply: DSH_SHIP_REPO/GITHUB_REPOSITORY unset}}"
DSH_BOT_DIR="${DSH_BOT_DIR:?post-reply: DSH_BOT_DIR unset}"
DSH_RUN_ID="${DSH_RUN_ID:-${GITHUB_RUN_ID:-}}"
TARGET_KIND="${TARGET_KIND:?post-reply: TARGET_KIND unset}"
TARGET_NUM="${TARGET_NUM:?post-reply: TARGET_NUM unset}"
case "$TARGET_KIND" in pr|issue) ;; *) echo "post-reply: TARGET_KIND must be pr|issue (got '$TARGET_KIND')" >&2; exit 2;; esac
DSH_SHIP_CACHE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}"
DSH_AGENT_OUTPUT="${DSH_AGENT_OUTPUT:-$DSH_SHIP_CACHE/dsh-agent-output.txt}"
DSH_REPLY_OUT="${DSH_REPLY_OUT:-$DSH_SHIP_CACHE/dsh-reply.md}"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

# gh may sit outside the runner service PATH on self-hosted cells (secondsee
# lane-lottery, 2026-08-26): probe the driver's persistent prefix + brew
# prefixes before giving up (identical list to the driver's CELL_PROBE_DIRS).
# The reply is the user-facing output channel, so a missing gh downgrades to
# a warning instead of a bare 127.
command -v gh >/dev/null 2>&1 \
  || export PATH="${DSH_CELL_BIN:-${HOME:-/root}/.dsh-bot-bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.doppler/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
command -v gh >/dev/null 2>&1 || {
  echo "::warning::gh unavailable — reply NOT posted to the thread; the agent's answer is in the run log/worker output ($DSH_AGENT_OUTPUT)"
  exit 0
}

# Run meta (written by the driver): every reply stamps the actual model
# and harness version — never a hardcoded label.
DSH_META_FILE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}/dsh-run-meta.env"
DSH_STAMP="dsh-agent"
if [ -f "$DSH_META_FILE" ]; then
  . "$DSH_META_FILE"
  DSH_STAMP="model: ${DSH_RUN_MODEL:-?} · harness: dsh-${DSH_RUN_DSH_VERSION:-?}"
fi
{
  echo "**dsh agent** — run: ${DSH_RUN_ID:-_} — lane: ${DSH_RUNNER_NAME:-unknown} — ${DSH_STAMP}"
  echo
  if [ -f "$DSH_AGENT_OUTPUT" ]; then
    node "$DSH_BOT_DIR/scripts/scrub-output.mjs" < "$DSH_AGENT_OUTPUT" 2>/dev/null \
      || echo "_(agent output withheld: scrubber unavailable)_"
  else
    echo "_(agent output file missing: $DSH_AGENT_OUTPUT)_"
  fi
  if [ -n "${DSH_SHIP_NOTE:-}" ]; then
    echo
    echo "**Shipped:** $DSH_SHIP_NOTE"
  elif [ -s "$DSH_SHIP_CACHE/dsh-ship-note.txt" ]; then
    echo
    echo "**Shipped:** $(cat "$DSH_SHIP_CACHE/dsh-ship-note.txt")"
  fi
} > "$DSH_REPLY_OUT"

if [ -n "${ACK_COMMENT_ID:-}" ]; then
  # edit the ack comment in place — one comment per task
  gh api "repos/${DSH_SHIP_REPO}/issues/comments/${ACK_COMMENT_ID}" -X PATCH \
    -F body="@$DSH_REPLY_OUT" >/dev/null
elif [ "$TARGET_KIND" = "pr" ]; then
  gh pr comment "$TARGET_NUM" --repo "$DSH_SHIP_REPO" --body-file "$DSH_REPLY_OUT"
else
  gh issue comment "$TARGET_NUM" --repo "$DSH_SHIP_REPO" --body-file "$DSH_REPLY_OUT"
fi