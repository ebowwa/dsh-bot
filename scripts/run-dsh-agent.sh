#!/usr/bin/env bash
# run-dsh-agent.sh — launch the DeepSeek Harness headless agent with GLM-5.3,
# secrets injected by Doppler. This is the robobun-style CI entrypoint.
#
# What it does:
#   1. Ensures the `dsh` CLI is installed (pinned to the running version).
#   2. Bootstraps $DSH_HOME/settings.yaml from config/settings.zai.yaml on a
#      fresh machine — declares the `zai` provider route (GLM via Z.AI coding
#      PAAS) and sets agent-default-model to zai/glm-5.3. Existing settings
#      are left untouched.
#   3. Runs `doppler run -- dsh --profile headless "<task>"` so Doppler injects
#      ZAI_API_KEY (and anything else in the project) into the process env.
#
# Usage:
#   DOPPLER_SERVICE_TOKEN=<token> bash run-dsh-agent.sh "implement X and open a PR"
#
# Env you may override:
#   DSH_HOME              harness home (default $HOME/.dsh)
#   DSH_VERSION           dsh npm version to install if missing (default 0.1.0-rc.7)
#   DSH_PERMISSION_MODE   sandbox/approval mode (default danger-full-access:
#                         no human to ask in CI, so approvals are never raised)
#   DOPPLER_SERVICE_TOKEN required by `doppler run`
#
# Comment-bot reply wiring (used by dsh-agent-comment.yml):
#   REPLY_TARGET    human label of the thread to answer, e.g. "PR #123"
#   TARGET_KIND     "pr" | "issue" — which `gh ... comment` subcommand to use
#   TARGET_NUM      the number the agent should reply to
#   GH_TOKEN        must be a PAT with issue/PR comment write access (BOT_PAT)

set -euo pipefail

# Fallback task for scheduled runs (workflow_dispatch provides a real task).
DEFAULT_TASK="${DEFAULT_TASK:-Routine maintenance task: check this repository for issues labeled agent-todo, pick the highest-priority one, and if the fix is clear, implement it, test it, and open a pull request. Otherwise report what you found.}"

TASK="${1:-$DEFAULT_TASK}"
if [ -z "$TASK" ]; then
  echo "error: no task given (pass it as \$1 or set DEFAULT_TASK)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Model-input hygiene (fail-closed): credentials are scrubbed from everything
# headed to the provider — the task text and the thread context. Paths/IPs/
# hosts are KEPT (a task may legitimately need them; a pasted key never is).
# If the scrubber cannot run, abort rather than send unscrubbed input.
if command -v node >/dev/null 2>&1; then
  TASK="$(printf '%s\n' "$TASK" | SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs" \
    || { echo "error: input scrubber failed; refusing to send unscrubbed task to the model" >&2; exit 3; })"
  if [ -n "${THREAD_CONTEXT:-}" ]; then
    THREAD_CONTEXT="$(printf '%s\n' "$THREAD_CONTEXT" | SECRETS_ONLY=1 node "$SCRIPT_DIR/scrub-output.mjs" \
      || { echo "error: input scrubber failed; refusing to send unscrubbed context" >&2; exit 3; })"
  fi
fi

# The triggering thread's context (issue/PR title, body, recent comments), if
# the workflow fetched it. Without this the agent cannot see "as described
# above" references — it only ever received the bare comment text.
if [ -n "${THREAD_CONTEXT:-}" ]; then
  TASK="Thread context (the issue/PR this comment belongs to):
$THREAD_CONTEXT

Your task (from the triggering comment):
$TASK"
fi

# Comment-bot mode: the workflow posts the reply itself (as github-actions[bot]
# via GITHUB_TOKEN), so the agent must NOT comment. It may still push commits
# and open PRs; author commits as the bot so attribution is not the runner user.
if [ "${REPLY_TARGET:-}" != "" ]; then
  TASK="${TASK}

Do not post comments yourself; the CI workflow relays your final answer and
AUTOMATICALLY SHIPS every code change you leave (committed or not) as a
branch + PR after you exit — do NOT push and do NOT open a PR yourself.
Just edit files and, when done, commit them as:
  git -c user.name=github-actions[bot] \
      -c user.email=github-actions[bot]@users.noreply.github.com \
      commit -am "..."   # or leave changes uncommitted; the shipper commits
Anything not present in the working tree or a local commit is lost with the
discarded checkout. Finish with a short factual summary of what changed.
SECURITY: never print API keys, tokens, internal IPs, or absolute home paths
in your output — assume anything you write may become public."
fi

# Per-job harness home by default: two runner lanes on one machine MUST NOT
# share $DSH_HOME (settings regeneration on one lane would race an in-flight
# job on the other), and a job-scoped home makes cleanup atomic (rm -rf).
# Set DSH_PERSISTENT_HOME=1 to opt back into a shared home (then
# DSH_KEEP_SESSIONS governs transcripts).
if [ -n "${DSH_PERSISTENT_HOME:-}" ]; then
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
else
  export DSH_HOME="${DSH_HOME:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dsh-home.$$}"
  JOB_SCOPED_HOME=1
fi
# Hostnames the scrubber redacts on output surfaces beyond the generic
# patterns; supplied by the consumer's (private) workflow config.
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

# Per-run model: "provider/model" (e.g. zai/glm-5.2). Settings are
# REGENERATED from the pristine template every run (never regex-patched in
# place): idempotent, immune to drift, restores the default after overrides.
#   DSH_MODEL=zai/glm-5.2      DSH_MODEL=opencode-go2/deepseek-v4-flash
EFFECTIVE_MODEL="${DSH_MODEL:-${DSH_DEFAULT_MODEL:-zai/glm-5.3}}"
case "$EFFECTIVE_MODEL" in
  */*) ;;
  *) echo "error: model must be provider/model (got '$EFFECTIVE_MODEL')" >&2; exit 2;;
esac
PROVIDER="${EFFECTIVE_MODEL%/*}"
MODEL_ID="${EFFECTIVE_MODEL#*/}"

SETTINGS_TEMPLATE="${DSH_SETTINGS_TEMPLATE:-$SCRIPT_DIR/../config/settings.zai.yaml}"
if [ -f "$SETTINGS_TEMPLATE" ]; then
  mkdir -p "$DSH_HOME"
  node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");const out=t.replace(/^  model: \S+$/m,"  model: "+process.argv[2]);fs.writeFileSync(process.argv[3],out);' \
    "$SETTINGS_TEMPLATE" "$MODEL_ID" "$DSH_HOME/settings.yaml" \
    || cp "$SETTINGS_TEMPLATE" "$DSH_HOME/settings.yaml"
  echo "run model: $PROVIDER/$MODEL_ID${DSH_MODEL:+ (overridden)}" >&2
elif [ -f "$DSH_HOME/settings.yaml" ]; then
  # no template available: leave existing settings (fleet default assumed)
  echo "run model: $PROVIDER/$MODEL_ID (no template; settings untouched)" >&2
fi

export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
DSH_VERSION="${DSH_VERSION:-0.1.0-rc.7}"

echo "::group::dsh setup" >&2
# --- 1. dsh CLI -----------------------------------------------------------
if ! command -v dsh >/dev/null 2>&1; then
  echo "installing @deepseek-ai/dsh@${DSH_VERSION}" >&2
  # Global first; on runners whose service user cannot write the system npm
  # prefix (EACCES on /usr/lib/node_modules), fall back to a user prefix and
  # put it on PATH for this process tree.
  if ! npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" 2>/dev/null; then
    NPM_USER_PREFIX="${DSH_HOME}/npm-global"
    npm install --prefix "$NPM_USER_PREFIX" "@deepseek-ai/dsh@${DSH_VERSION}"
    export PATH="${NPM_USER_PREFIX}/bin:$PATH"
  fi
fi
dsh --version >&2

# --- 2. harness home + settings (zai provider, glm-5.3 default) ------------
mkdir -p "$DSH_HOME"
if [ ! -f "$DSH_HOME/settings.yaml" ]; then
  echo "writing initial $DSH_HOME/settings.yaml from config/settings.zai.yaml" >&2
  cp "$REPO_ROOT/config/settings.zai.yaml" "$DSH_HOME/settings.yaml"
else
  echo "settings.yaml already present; leaving untouched" >&2
fi
echo "::endgroup::" >&2

echo "::group::dsh agent (GLM-5.3 via Z.AI)" >&2
# --- 2b. gh identity for the agent ------------------------------------------
# dsh scrubs KEY/PASSWORD/SECRET/TOKEN env vars from agent child processes
# (dsh-subprocess SENSITIVE_ENV_PATTERN) — so GH_TOKEN never reaches the
# agent's bash, and gh would silently fall back to the runner user's cached
# login (a personal account!). GH_CONFIG_DIR does NOT match the scrub: write
# the job token into an isolated gh config dir and export it. The agent's gh
# is then github-actions[bot], and the runner's personal hosts.yml is
# invisible to agent jobs entirely.
if [ -n "${GH_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GH_BOT_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/gh-bot-config.$$"
  mkdir -p "$GH_BOT_DIR" && chmod 700 "$GH_BOT_DIR"
  printf 'github.com:\n    oauth_token: %s\n    user: github-actions[bot]\n    git_protocol: https\n' "$GH_TOKEN" \
    > "$GH_BOT_DIR/hosts.yml" && chmod 600 "$GH_BOT_DIR/hosts.yml"
  export GH_CONFIG_DIR="$GH_BOT_DIR"
fi

# --- 2c. gh/git scrub shims: the scrubber BETWEEN agent and GitHub ---------
# The agent is told not to post comments, but instruction is not enforcement.
# These shims ARE enforcement: installed at the front of the agent's PATH,
# every text-bearing gh/git argument (bodies, titles, review text, commit and
# tag messages, api -f fields, body-files) passes scrub-output.mjs before it
# reaches the real binary. Env names deliberately avoid the
# KEY/PASSWORD/SECRET/TOKEN patterns (dsh strips those from child env) and
# the DSH_ prefix (also stripped).
SCRUB_SCRIPT_EXPORT="$SCRIPT_DIR/scrub-output.mjs"
if [ -x "$SCRIPT_DIR/gh-scrub-shim" ] || [ -x "$SCRIPT_DIR/git-scrub-shim" ]; then
  SHIM_BIN="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dsh-shim.$$"
  mkdir -p "$SHIM_BIN"
  export SCRUB_SCRIPT="$SCRUB_SCRIPT_EXPORT"
  if command -v gh >/dev/null 2>&1 && [ -x "$SCRIPT_DIR/gh-scrub-shim" ]; then
    export GH_SCRUB_REAL="$(command -v gh)"
    cp "$SCRIPT_DIR/gh-scrub-shim" "$SHIM_BIN/gh" && chmod +x "$SHIM_BIN/gh"
  fi
  if command -v git >/dev/null 2>&1 && [ -x "$SCRIPT_DIR/git-scrub-shim" ]; then
    export GIT_SCRUB_REAL="$(command -v git)"
    cp "$SCRIPT_DIR/git-scrub-shim" "$SHIM_BIN/git" && chmod +x "$SHIM_BIN/git"
  fi
  export PATH="$SHIM_BIN:$PATH"
fi

# --- 3. Doppler-injected run, with live progress ---------------------------
# `doppler run` derives project + config from the service token and exports
# every secret in that config as env. dsh-llm-pi-ai resolves apiKeyEnv:
# ZAI_API_KEY per request from process env — no key file ever touches disk.
#
# The headless runner is silent until it finishes, so a long task shows a dead
# log. Sessions are persisted (zstd JSONL) and flushed at every durability
# checkpoint, so this driver tails the session file while dsh runs and streams
# a compact event trace (tool calls, results, reasoning) to stderr — visible
# live in the Actions log, never in the reply (stdout stays final-answer-only).
FINAL_OUT="$(mktemp /tmp/dsh-agent-answer.XXXXXX)"
MARKER="$(mktemp /tmp/dsh-agent-marker.XXXXXX)"
touch "$MARKER"

# env -u: the Doppler token is consumed by `doppler run` itself before exec;
# the agent must never see it (an `env` tool call would ship it to the model
# provider). ZAI_API_KEY must remain — it IS the inference credential.
doppler run --token "$DOPPLER_SERVICE_TOKEN" -- \
  env -u DOPPLER_SERVICE_TOKEN -u DOPPLER_CONFIG -u DOPPLER_PROJECT -u DOPPLER_ENVIRONMENT \
  dsh --profile headless "$TASK" >"$FINAL_OUT" &
DSH_PID=$!

stream_session_progress() {
  # $1: marker newer-than, $2: pid of dsh wrapper
  local tmp_jsonl seen=0 total  # session_file deliberately global (cleanup)
  command -v zstd >/dev/null 2>&1 || return 0
  [ -x "$(command -v node)" ] || return 0
  tmp_jsonl="$(mktemp /tmp/dsh-progress-slice.XXXXXX)"
  # The session file appears once the agent is created (a few seconds in).
  for _ in $(seq 1 60); do
    kill -0 "$2" 2>/dev/null || break
    session_file="$(find "$DSH_HOME/sessions" -name 'session.jsonl.zstd' -newer "$1" -print -quit 2>/dev/null)"
    [ -n "$session_file" ] && break
    sleep 2
  done
  [ -n "$session_file" ] || { echo "(no live session file found; progress unavailable)" >&2; return 0; }
  # A backgrounded function cannot set parent-shell variables — hand the
  # path to the parent through the filesystem so cleanup can find it.
  SESSION_PATH_FILE="${DSH_SESSION_PATH_FILE:-${TMPDIR:-/tmp}/dsh-session-path.$$}"
  echo "$session_file" > "$SESSION_PATH_FILE" 2>/dev/null || true
  echo "(streaming live session trace — secrets/paths scrubbed)" >&2
  while kill -0 "$2" 2>/dev/null; do
    if zstd -dc "$session_file" >"$tmp_jsonl" 2>/dev/null; then
      total=$(wc -l <"$tmp_jsonl" | tr -d ' ')
      if [ "$total" -gt "$seen" ]; then
        tail -n "+$((seen + 1))" "$tmp_jsonl" \
          | node "$SCRIPT_DIR/dsh-progress.mjs" 2>/dev/null \
          | node "$SCRIPT_DIR/scrub-output.mjs" >&2 || true
        seen=$total
      fi
    fi
    sleep 4
  done
  rm -f "$tmp_jsonl"
}

stream_session_progress "$MARKER" "$DSH_PID" &
PROGRESS_PID=$!

wait "$DSH_PID"
RC=$?
wait "$PROGRESS_PID" 2>/dev/null || true
echo "::endgroup::" >&2

# The session transcript on the runner contains everything the agent saw,
# including any secret a tool result echoed. Default: delete it. Set
# DSH_KEEP_SESSIONS=1 to keep transcripts for debugging.
if [ "${DSH_KEEP_SESSIONS:-0}" != "1" ]; then
  SESSION_PATH="$(cat "${DSH_SESSION_PATH_FILE:-${TMPDIR:-/tmp}/dsh-session-path.$$}" 2>/dev/null || true)"
  if [ -n "$SESSION_PATH" ]; then
    rm -rf "$(dirname "$SESSION_PATH")" 2>/dev/null || true
    rm -f "${DSH_SESSION_PATH_FILE:-${TMPDIR:-/tmp}/dsh-session-path.$$}" 2>/dev/null || true
  fi
fi

# stdout carries ONLY the agent's final answer (the comment workflow tees it).
cat "$FINAL_OUT"
rm -f "$FINAL_OUT" "$MARKER"

# Atomic cleanup: a job-scoped home (transcripts, per-run settings, profile
# symlinks) is deleted whole — nothing from this job survives on the runner
# unless DSH_KEEP_SESSIONS=1 (transcripts kept for debugging) or the home is
# persistent/shared (older path-based cleanup applies).
if [ "${JOB_SCOPED_HOME:-0}" = "1" ] && [ "${DSH_KEEP_SESSIONS:-0}" != "1" ]; then
  rm -rf "$DSH_HOME" 2>/dev/null || true
fi
exit "$RC"
