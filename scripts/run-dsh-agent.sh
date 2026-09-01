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
#   DSH_MODEL             head model, "provider/model" (default zai/glm-5.3)
#   DSH_SUBAGENT_MODEL    subagent/subagent_fork children's model, "provider/model"
#                         (unset = inherit the head's route)
#   DSH_WEB_SEARCH_CELLS  comma-separated runner names where the local
#                         web-search-browser provider is mounted (per-cell
#                         adoption; unset/empty = off everywhere). Requires the
#                         cell's plugin copy (DSH_WEB_SEARCH_BROWSER_PATH,
#                         default $HOME/.dsh/profiles/node_modules/@local/
#                         dsh-web-search-browser) and fails loud without it.
#   DSH_WEB_SEARCH_BROWSER_BROWSERS   optional space-separated browser binary
#                         paths pinned into the provider row (chrome-headless-
#                         shell cells where full-browser new-headless hangs).
#                         Each entry must be a plain [A-Za-z0-9._/@+-] path AND
#                         an existing executable file — both fail loud (a pin
#                         containing a space splits at the separator before the
#                         charset test; the filesystem check catches it).
#   DSH_SEARCH_COMPOSE  set to 1 to mount the composition search tool
#                       (plugins/tool-search-compose — counts/file-lists/
#                       case-fold/context/total-cap/ordering in one search
#                       call). The launcher copies the packaged plugin into
#                       the profile module tree and stamps the overlay; its
#                       @deepseek-ai deps resolve through the profile's flat
#                       fallback (the f2972e7 bare-path mount resolved
#                       nothing). Unset = off, byte-identical launch line.
#   DOPPLER_SERVICE_TOKEN required by `doppler run`
#   DSH_CELL_BIN        persistent prefix for the cell-tool bootstrap
#                       (default $HOME/.dsh-bot-bin); the relay/reply
#                       guards in the workflows honor the same seam. gh
#                       is NOT a hard driver requirement (soft: warn and
#                       run — the workflows own gh absence); doppler is.
#
# Comment-bot reply wiring (used by dsh-agent-comment.yml):
#   REPLY_TARGET    human label of the thread to answer, e.g. "PR #123"
#   TARGET_KIND     "pr" | "issue" — which `gh ... comment` subcommand to use
#   TARGET_NUM      the number the agent should reply to
#   GH_TOKEN        must be a PAT with issue/PR comment write access (BOT_PAT)

set -euo pipefail
# Linux runner services can start jobs WITHOUT $HOME in env (observed
# 2026-08-25: seed-secondsee review died "Unable to determine home
# directory" -> Doppler "$HOME is not defined" -> no ZAI_API_KEY ->
# unbound session_file at exit). mac cells always carry it; make the
# script indifferent: derive HOME from the passwd entry when unset.
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" | cut -d: -f6 || true)"
  [ -n "$HOME" ] && export HOME || { echo "::error::no $HOME and no passwd entry — cannot run" >&2; exit 1; }
fi

# Fallback task for scheduled runs (workflow_dispatch provides a real task).
DEFAULT_TASK="${DEFAULT_TASK:-Routine maintenance task: check this repository for issues labeled agent-todo, pick the highest-priority one, and if the fix is clear, implement it, test it, and open a pull request. Otherwise report what you found.}"

TASK="${1:-$DEFAULT_TASK}"
if [ -z "$TASK" ]; then
  echo "error: no task given (pass it as \$1 or set DEFAULT_TASK)" >&2
  exit 2
fi

# The agent always launches via `doppler run --token "$DOPPLER_SERVICE_TOKEN"`
# — there is no local-auth fallback. Under set -u an unset token died with a
# bare "unbound variable" at the launch line (after installing dsh + probing
# cell tools); make it a typed, early, cheap failure instead. This is a
# REQUIRED env in every caller (CI secrets, dsh-worker's env file).
if [ -z "${DOPPLER_SERVICE_TOKEN:-}" ]; then
  echo "error: DOPPLER_SERVICE_TOKEN unset — the agent launches through \`doppler run --token\`; CI and the worker env file must provide it" >&2
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
# JOB_SCOPED_HOME is 1 ONLY when this script minted the home itself — an
# externally-supplied DSH_HOME is never rm -rf'd at exit, whatever mode.
if [ -n "${DSH_HOME:-}" ] || [ -n "${DSH_PERSISTENT_HOME:-}" ]; then
  export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
else
  export DSH_HOME="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dsh-home.$"
  # Publish the job-scoped home to the workflow (flight recorder): the
  # upload step cannot see this shell process exports, and $ is the
  # script PID — unknowable outside. GITHUB_ENV carries it as DSH_HOME_JOB.
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "DSH_HOME_JOB=${DSH_HOME}" >> "$GITHUB_ENV"
  fi
  JOB_SCOPED_HOME=1
fi
# Hostnames the scrubber redacts on output surfaces beyond the generic
# patterns; supplied by the consumer's (private) workflow config.
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

# --- 0. cell tooling: probe prefixes, then bootstrap missing tools --------
# Lane-lottery defect (secondsee 2026-08-26, runs 32944063408 / 32941451004):
# widening runner-labels to ["self-hosted"] lets reviews land on ANY cell in
# a fleet, and two of three secondsee cells had no gh/doppler on the runner
# SERVICE PATH (mac launchd safe-path class: tools exist under a brew prefix
# the service never sees, or were never installed) — the review died at the
# first `doppler run` with a bare "command not found" (line 227 of v1.27.0).
# node stays a hard requirement (this driver itself runs on it); doppler and
# gh are ensured here, cheapest first:
#   1. probe known prefixes onto PATH (fixes the regressed-PATH case with
#      zero network),
#   2. install into a PERSISTENT user prefix (~/.dsh-bot-bin — survives
#      steps and runs, so the first hardened run pays the cost and later
#      runs just find the binaries),
#   3. fail LOUD with the provisioning hint — never limp on half a
#      toolchain (a missing doppler at `doppler run` means no ZAI_API_KEY
#      and a dead agent; a missing gh means no identity, no verdict).
CELL_BIN="${DSH_CELL_BIN:-$HOME/.dsh-bot-bin}"
# Probe order: the persistent cell prefix, the brew prefixes a mac/linux
# runner service PATH may have regressed away from, and doppler's own
# default. CELL_PROBE_DIRS is a TEST SEAM (space list) — callers never set
# it; the offline suite needs to rule out the dev machine's real prefixes.
CELL_PROBE_DIRS="${CELL_PROBE_DIRS:-$CELL_BIN /opt/homebrew/bin /usr/local/bin $HOME/.doppler/bin /home/linuxbrew/.linuxbrew/bin}"
CELL_ADDED_PREFIXES=""
cell_probe_prefixes() {
  local p
  for p in $CELL_PROBE_DIRS; do
    [ -d "$p" ] || continue
    case ":$PATH:" in *":$p:"*) ;; *)
      PATH="$p:$PATH"
      CELL_ADDED_PREFIXES="${CELL_ADDED_PREFIXES:+$CELL_ADDED_PREFIXES }$p"
      ;;
    esac
  done
  export PATH
}
ensure_cell_tools() {
  # *_BIN are TEST SEAMS only — callers never set them. Explicit paths let
  # the offline suite construct a tool's absence; the dsh lanes install
  # real CLIs in system dirs, so PATH restriction alone cannot (the
  # resolve-push-token suite earned this rule the hard way, gates run
  # 32933615526).
  local node_bin="${NODE_BIN:-node}" doppler_bin="${DOPPLER_BIN:-doppler}" gh_bin="${GH_BIN:-gh}"
  cell_probe_prefixes
  # node is hard, but checked AFTER the probe: a cell whose node lives only
  # under a brew prefix the service PATH regressed away from (the exact
  # incident class this section handles for gh/doppler) must not die one
  # line before the probe that would have found it (review r2 finding 6).
  command -v "$node_bin" >/dev/null 2>&1 \
    || { echo "error: node missing on this cell — the driver itself needs it; provision the runner" >&2; return 1; }
  # Failed-install stderr tails, surfaced in the final hint (a bare
  # "fetch failed" hides 404s vs no-egress — review r1 finding 4).
  local errlog; errlog="$(mktemp)"
  if ! command -v "$doppler_bin" >/dev/null 2>&1; then
    echo "cell-tools: doppler missing — installing (official install.sh --install-path $CELL_BIN)" >&2
    mkdir -p "$CELL_BIN"
    # install.sh honors --install-path and upgrades an existing binary in
    # place; verified against the script source (arg parse, Feb 2026).
    # The capture binds to CURL: a `2>` on the pipeline tail captures sh's
    # stderr instead, leaving the hint empty of the transport error that
    # distinguishes 404 from no-egress (review r2 finding 3). sh's own
    # stderr flows to the job log unredirected.
    if ! curl -fsSL https://cli.doppler.com/install.sh 2>"$errlog" | sh -s -- --install-path "$CELL_BIN"; then
      echo "cell-tools: doppler install.sh failed:" >&2; sed 's/^/  /' "$errlog" | tail -3 >&2
    fi
    cell_probe_prefixes
  fi
  if ! command -v "$gh_bin" >/dev/null 2>&1; then
    GH_FLAVOR="$(uname -s):$(uname -m)"
    case "$GH_FLAVOR" in
      Darwin:*) install_gh_release darwin ;;
      Linux:*) install_gh_release linux ;;
      *) echo "cell-tools: unsupported cell OS/arch ($GH_FLAVOR) for gh install" >&2 ;;
    esac
    cell_probe_prefixes
  fi
  # Publish additions to later steps in the SAME job (shipper, relay,
  # reply): GITHUB_PATH is the sanctioned per-line mechanism. The shell
  # export dies with this step; workflow steps after us must also find
  # gh/doppler (a missing gh at the relay was the second 127 in the
  # secondsee failures). ONCE, HERE — not inside cell_probe_prefixes,
  # which runs up to 3× per bare cell (initial probe, post-doppler,
  # post-gh) and appended the same prefixes on every call (review r2
  # finding 4).
  if [ -n "$CELL_ADDED_PREFIXES" ] && [ -n "${GITHUB_PATH:-}" ]; then
    for p in $CELL_ADDED_PREFIXES; do echo "$p" >> "$GITHUB_PATH"; done
    # and the resolved prefix itself, job-ambient: the workflow guards'
    # ${DSH_CELL_BIN:-...} probe only sees it if this step publishes it
    # (review approve-round finding 3).
    [ -n "${GITHUB_ENV:-}" ] && printf 'DSH_CELL_BIN=%s\n' "$CELL_BIN" >> "$GITHUB_ENV"
  fi
  # doppler is a HARD requirement (the driver launches the agent through
  # `doppler run`); gh is not (the driver's own gh uses are guarded — the
  # surrounding workflows' relay/reply guards own a missing gh). A cell
  # that cannot get gh still runs the agent; review r1 finding 2.
  if ! command -v "$doppler_bin" >/dev/null 2>&1; then
    echo "error: cell tooling still missing after bootstrap: doppler" >&2
    echo "hint: provision the runner service PATH (doppler) or install" >&2
    echo "      manually: brew install doppler — the driver bootstraps to" >&2
    echo "      $CELL_BIN but needs egress to cli.doppler.com" >&2
    return 1
  fi
  if ! command -v "$gh_bin" >/dev/null 2>&1; then
    echo "::warning::gh unavailable on this cell — the agent runs, but gh-dependent steps (identity, verdicts, relays) degrade" >&2
  fi
  echo "cell-tools: node/doppler present (PATH ok; gh: $(command -v "$gh_bin" >/dev/null 2>&1 && echo present || echo absent))" >&2
}
# install_gh_release <darwin|linux> — latest gh into $CELL_BIN.
# Asset shapes are NOT symmetric (review r1 finding 1, verified against
# cli/cli v2.98.0): Linux ships .tar.gz with members gh_<ver>_<flavor>/bin/gh
# (strip 2 lands the binary AT $CELL_BIN/gh); macOS ships .zip ONLY — the
# .tar.gz URL 404s on every mac cell — extracted via unzip -p.
install_gh_release() {
  echo "cell-tools: gh missing — installing latest release into $CELL_BIN" >&2
  mkdir -p "$CELL_BIN"
  local errlog; errlog="$(mktemp)"
  # || true INSIDE the substitution: the driver runs under set -euo
  # pipefail, and an assignment's status is its substitution's — a failed
  # resolve (no egress) would abort the whole driver HERE, before the
  # soft-gh warning / the doppler hard-fail hint ever print (residual on
  # 3f690a2, verified in the driver's shell context). The empty-string
  # fallthrough below is the intended degradation.
  GH_VER="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest 2>"$errlog" \
    | sed -n 's#.*/tag/v\([0-9][0-9.]*\)$#\1#p' || true)"
  [ -n "$GH_VER" ] || { echo "cell-tools: could not resolve latest gh release:" >&2; sed 's/^/  /' "$errlog" | tail -3 >&2; return 0; }
  case "$1" in
    linux)
      local flavor; case "$(uname -m)" in aarch64|arm64) flavor="arm64" ;; *) flavor="amd64" ;; esac
      curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_${flavor}.tar.gz" 2>"$errlog" \
        | tar -xz -C "$CELL_BIN" --strip-components=2 "gh_${GH_VER}_linux_${flavor}/bin/gh" \
        || { echo "cell-tools: gh tarball fetch/extract failed:" >&2; sed 's/^/  /' "$errlog" | tail -3 >&2; return 0; }
      ;;
    darwin)
      local flavor; case "$(uname -m)" in aarch64|arm64) flavor="arm64" ;; *) flavor="amd64" ;; esac
      local z; z="$(mktemp)"
      curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_macOS_${flavor}.zip" -o "$z" 2>"$errlog" \
        || { echo "cell-tools: gh zip fetch failed:" >&2; sed 's/^/  /' "$errlog" | tail -3 >&2; rm -f "$z"; return 0; }
      # macOS ships unzip; the archive root is gh_<ver>_<flavor>/bin/gh.
      # rm the target on failure too: the redirect creates it even when
      # unzip fails — an empty artifact must not linger in the persistent
      # prefix.
      unzip -p "$z" '*/bin/gh' > "$CELL_BIN/gh" 2>"$errlog" \
        || { echo "cell-tools: gh zip extract failed:" >&2; sed 's/^/  /' "$errlog" | tail -3 >&2; rm -f "$z" "$CELL_BIN/gh"; return 0; }
      rm -f "$z"
      ;;
  esac
  chmod +x "$CELL_BIN/gh" 2>/dev/null || echo "cell-tools: chmod on $CELL_BIN/gh failed (extract incomplete?)" >&2
}
ensure_cell_tools


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
# Run meta: every downstream surface (reply comments, PR bodies, shipper
# commits, review headers) stamps the model + harness version — the
# driver is the only place that knows both. Written where the shipper and
# reply steps read it (DSH_SHIP_CACHE, else the runner temp).
DSH_META_DIR="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
DSH_VERSION_RESOLVED="$(dsh --version 2>/dev/null | tail -n1 | tr -d '[:space:]')"
{
  echo "DSH_RUN_MODEL=${MODEL_ID}"
  echo "DSH_RUN_PROVIDER=${PROVIDER}"
  echo "DSH_RUN_DSH_VERSION=${DSH_VERSION_RESOLVED}"
} > "$DSH_META_DIR/dsh-run-meta.env" 2>/dev/null || true


# --- 2. harness home + settings (zai provider, glm-5.3 default) ------------
mkdir -p "$DSH_HOME"
if [ ! -f "$DSH_HOME/settings.yaml" ]; then
  echo "writing initial $DSH_HOME/settings.yaml from config/settings.zai.yaml" >&2
  cp "$REPO_ROOT/config/settings.zai.yaml" "$DSH_HOME/settings.yaml"
else
  echo "settings.yaml already present; leaving untouched" >&2
fi
echo "::endgroup::" >&2

echo "::group::dsh agent (${MODEL_ID} via ${PROVIDER})" >&2
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
  # Resolve the gh identity FROM THE TOKEN: a PAT must push as its owner
  # (BOT_PAT exists so cross-repo tower tickets can push to targets like
  # ebowwa/ANE — the factory write-probe proved the PAT CAN write there
  # while agent pushes went 0/8, every one denied because this hardcode
  # made every agent the installation bot). Only the github.token
  # fallback actually IS the bot.
  GH_USER="$(gh api user --jq .login 2>/dev/null || printf 'github-actions[bot]')"
  printf 'github.com:\n    oauth_token: %s\n    user: %s\n    git_protocol: https\n' "$GH_TOKEN" "$GH_USER" \
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

# --- 2d. subagent model override (issue #220: submodels on turbo) ----------
# DSH_SUBAGENT_MODEL routes the plain subagent/subagent_fork children (the
# two dsh-tool-subagent instances) to "provider/model" instead of the head's
# route. Unset = inherit the parent = today's behavior: no patch file, no
# extra flag, byte-identical launch line. The override rides a REGENERATED
# patch overlay (same idempotence rule as the settings stamp above): a patch
# row REPLACES the whole plugin config, so provider/toolName/backgroundMode
# are restated from the headless profile defaults alongside agentOptions.
# The model id must exist in the settings catalog — an unknown id fails loud
# at the first child spawn (UNKNOWN_MODEL), same as a bogus DSH_MODEL.
# Validation is charset+shape, NOT mere slash-presence: the halves are
# stamped into STRUCTURED YAML below, so a newline in the value injects
# sibling agentOptions keys, a `#` comments the rest of a line away, a `:`
# reinterprets a scalar, a space splits a key — all of those pass a
# slash-only check. A glob case class cannot express "only these chars"
# (its trailing `*` is an UNBOUNDED star, not a class quantifier), so the
# charset check deletes the allowed set and requires an empty residue;
# anchored shape cases then pin exactly-one-slash + alnum starts.
SUBAGENT_PATCH_FILE=""
if [ -n "${DSH_SUBAGENT_MODEL:-}" ]; then
  case "$DSH_SUBAGENT_MODEL" in
    */*) ;;
    *) echo "error: DSH_SUBAGENT_MODEL must be provider/model (got '$DSH_SUBAGENT_MODEL')" >&2; exit 2;;
  esac
  SUBAGENT_RESIDUE="${DSH_SUBAGENT_MODEL//[A-Za-z0-9._-]/}"
  SUBAGENT_RESIDUE="${SUBAGENT_RESIDUE//\//}"
  if [ -n "$SUBAGENT_RESIDUE" ]; then
    echo "error: DSH_SUBAGENT_MODEL may contain only [A-Za-z0-9._-/] — the value is stamped into structured YAML, metacharacters are rejected (got '$DSH_SUBAGENT_MODEL')" >&2
    exit 2
  fi
  case "$DSH_SUBAGENT_MODEL" in
    /*|*/|*/*/*|*/[!A-Za-z0-9]*|[!A-Za-z0-9]*)
      echo "error: DSH_SUBAGENT_MODEL must be provider/model — exactly one '/', both halves non-empty and starting [A-Za-z0-9] (got '$DSH_SUBAGENT_MODEL')" >&2
      exit 2;;
  esac
  SUB_PROVIDER="${DSH_SUBAGENT_MODEL%/*}"
  SUB_MODEL_ID="${DSH_SUBAGENT_MODEL#*/}"
  SUBAGENT_PATCH_FILE="$DSH_HOME/subagent-model.patch.yml"
  {
    echo "# Stamped by run-dsh-agent.sh from DSH_SUBAGENT_MODEL=$DSH_SUBAGENT_MODEL (regenerated every run)."
    echo "# Patch rows replace the whole plugin config: provider/toolName/backgroundMode"
    echo "# restated from the headless profile defaults; agentOptions overrides the route"
    echo "# the children would otherwise inherit from the head (resolveChildAgentOptions)."
    echo "- id: tool-subagent"
    echo "  config:"
    echo "    provider: spawn"
    echo "    toolName: subagent"
    echo "    backgroundMode: continuable"
    echo "    agentOptions:"
    echo "      provider: $SUB_PROVIDER"
    echo "      model: $SUB_MODEL_ID"
    echo "- id: tool-subagent-fork"
    echo "  config:"
    echo "    provider: fork"
    echo "    toolName: subagent_fork"
    echo "    backgroundMode: one-shot"
    echo "    agentOptions:"
    echo "      provider: $SUB_PROVIDER"
    echo "      model: $SUB_MODEL_ID"
  } > "$SUBAGENT_PATCH_FILE"
  echo "subagent model: $SUB_PROVIDER/$SUB_MODEL_ID (subagent + subagent_fork; head stays $PROVIDER/$MODEL_ID)" >&2
fi
# --- 2e. local web search + fetch provider (per-cell, default-off) ---------
# DSH_WEB_SEARCH_CELLS mounts the local key-free ctx.web provider
# (@local/dsh-web-search-browser, issue #293) — but ONLY on cells the caller
# listed, and only when this job's runner is one of them: the adoption gates
# (packaging resolves, dsh version parity, a live smoke on that exact cell)
# are per-cell facts, so enablement is per-cell too. Default (unset/empty)
# is off on every cell — no silent fleet-wide flip.
# When the runner name matches, this block:
#   1. copies the CELL's canonical plugin copy into THIS job's profile module
#      fallback ($DSH_HOME/profiles/node_modules/@local/). A job-scoped home
#      is minted fresh per run, so the upstream deploy path (a copy in the
#      profile tree, peers resolving through the flat fallback) is
#      re-performed on every launch; a missing or incomplete copy fails loud
#      — a plugin that cannot resolve its deps is a dead mount, and a dead
#      mount must never look like a working one;
#   2. stamps a REGENERATED --patch overlay (same idempotence rule as the
#      settings and subagent-model stamps): the `web` row restated with
#      searchProvider: headless-browser and the `tool-web` row restated with
#      fetch: true (patch rows REPLACE whole plugin config, so both must be
#      restatements, not additions), then the provider row itself. The
#      provider row rides an explicit `insert:` list — a bare row whose id
#      does not exist in the tree only warns ("entry not found") and is
#      skipped, which is a silently-dead patch, the exact failure the insert
#      grammar exists to prevent;
#   3. optionally pins browser binaries (DSH_WEB_SEARCH_BROWSER_BROWSERS,
#      space-separated paths): some CI cells have no working new-headless
#      Chrome/Brave session (the render hangs producing no DOM) while the
#      standalone chrome-headless-shell binary works — the provider's
#      `browsers` config is the supported seam for that. The values are
#      stamped into structured YAML, so the charset is validated and
#      metacharacters fail loud.
# The plugin source default is the deployment-canonical location; override
# with DSH_WEB_SEARCH_BROWSER_PATH.
WEB_PATCH_FILE=""
if [ -n "${DSH_WEB_SEARCH_CELLS:-}" ] && [ -n "${RUNNER_NAME:-}" ]; then
  # Comma-separated entries, each matched as a GLOB against the runner name:
  # exact names ("mini-dsh-2") and machine-level prefixes ("mini-dsh*", which
  # covers the standing services AND the elastic pool spawned on the same
  # hardware) both work; an entry only ever WIDENS what mounts, so matching
  # stays an affirmative listed-cell gate, never a substring accident.
  for web_cell in ${DSH_WEB_SEARCH_CELLS//,/ }; do
    [ -n "$web_cell" ] || continue
    case "$RUNNER_NAME" in
      $web_cell)
        WEB_CELL_MATCH=1
        break
        ;;
    esac
  done
  if [ "${WEB_CELL_MATCH:-}" = "1" ]; then
      WEB_PLUGIN_SRC="${DSH_WEB_SEARCH_BROWSER_PATH:-$HOME/.dsh/profiles/node_modules/@local/dsh-web-search-browser}"
      if [ ! -f "$WEB_PLUGIN_SRC/package.json" ] || [ ! -f "$WEB_PLUGIN_SRC/lib/index.js" ]; then
        echo "error: web-search-browser is listed for runner '$RUNNER_NAME' (DSH_WEB_SEARCH_CELLS) but the per-cell plugin copy is missing or incomplete at $WEB_PLUGIN_SRC" >&2
        echo "hint: provision the cell first — copy the package (HelloMacOScreator web-search-browser/, v0.3.2+) into the profile module tree and pass its live smoke (one search + one fetch) before listing this runner name" >&2
        exit 2
      fi
      mkdir -p "$DSH_HOME/profiles/node_modules/@local"
      WEB_PLUGIN_DST="$DSH_HOME/profiles/node_modules/@local/dsh-web-search-browser"
      # Same-tree guard: the source DEFAULT is the canonical per-cell location
      # ($HOME/.dsh/profiles/...), which in persistent-home mode
      # (DSH_PERSISTENT_HOME=1, or any externally-supplied DSH_HOME equal to
      # it) IS the destination. An unconditional rm -rf + cp -R there deletes
      # the provisioned copy before copying from it — run 1 dies with a bare
      # `cp: cannot stat` and every later run on that cell finds the copy
      # "missing or incomplete" (review r1 finding 1). Resolve both trees
      # physically and re-copy only when they differ; when they match, the
      # copy already sits in the job-visible profile tree and only the
      # overlay needs stamping.
      WEB_SRC_REAL="$(cd "$(dirname "$WEB_PLUGIN_SRC")" && pwd -P)/$(basename "$WEB_PLUGIN_SRC")"
      WEB_DST_REAL="$(cd "$(dirname "$WEB_PLUGIN_DST")" && pwd -P)/$(basename "$WEB_PLUGIN_DST")"
      if [ "$WEB_SRC_REAL" != "$WEB_DST_REAL" ]; then
        rm -rf "$WEB_PLUGIN_DST"
        cp -R "$WEB_PLUGIN_SRC" "$WEB_PLUGIN_DST"
        WEB_COPY_NOTE="plugin copied from $WEB_PLUGIN_SRC"
      else
        WEB_COPY_NOTE="source IS the canonical copy — re-copy skipped (same-tree guard)"
      fi
      WEB_BROWSERS_BLOCK=""
      if [ -n "${DSH_WEB_SEARCH_BROWSER_BROWSERS:-}" ]; then
        WEB_BROWSERS_BLOCK="        browsers:"
        for web_browser in ${DSH_WEB_SEARCH_BROWSER_BROWSERS}; do
          case "$web_browser" in
            *[!A-Za-z0-9._/@+-]*)
              echo "error: DSH_WEB_SEARCH_BROWSER_BROWSERS entries must be plain paths of [A-Za-z0-9._/@+-] (got '$web_browser') — the value is stamped into structured YAML" >&2
              exit 2;;
          esac
          # Filesystem check AFTER the split: the whitespace separator cuts a
          # space-containing pin in half BEFORE the charset test can see it,
          # and both halves pass the charset — only an existence + exec-bit
          # check catches the corrupted halves (review r1 finding 2:
          # '/opt/My Browser/shell' used to stamp two bogus list items and
          # exit 0, the silently-dead-pin class this feature refuses).
          if [ ! -x "$web_browser" ]; then
            echo "error: DSH_WEB_SEARCH_BROWSER_BROWSERS entry '$web_browser' is not an existing executable file — a pin containing a space splits into entries like this one before validation; pin a space-free path (or a symlink without one)" >&2
            exit 2
          fi
          WEB_BROWSERS_BLOCK="$WEB_BROWSERS_BLOCK
          - $web_browser"
        done
      fi
      WEB_PATCH_FILE="$DSH_HOME/web-search-browser.patch.yml"
      {
        echo "# Stamped by run-dsh-agent.sh (DSH_WEB_SEARCH_CELLS lists runner '${RUNNER_NAME}'; regenerated every run)."
        echo "# Local key-free ctx.web provider (issue #293): the web and tool-web rows are whole-config"
        echo "# restatements (searchProvider pin; fetch switch + budgets); the provider row is an explicit"
        echo "# insert list, because a bare row with an unknown id only warns and is silently skipped."
        echo "- id: web"
        echo "  name: '@deepseek-ai/dsh-web'"
        echo "  config:"
        echo "    searchProvider: headless-browser"
        echo "- id: tool-web"
        echo "  name: '@deepseek-ai/dsh-tool-web'"
        echo "  config:"
        echo "    fetch: true"
        echo "    searchTimeoutMs: 60000"
        echo "    fetchTimeoutMs: 60000"
        echo "- insert:"
        echo "    - id: web-search-browser"
        echo "      name: '@local/dsh-web-search-browser'"
        echo "      config:"
        echo "        engines: [duckduckgo, bing, mojeek]"
        echo "        timeoutMs: 30000"
        echo "        fetchMaxChars: 100000"
        if [ -n "$WEB_BROWSERS_BLOCK" ]; then
          printf '%s\n' "$WEB_BROWSERS_BLOCK"
        fi
      } > "$WEB_PATCH_FILE"
      echo "web-search-browser: mounted for this run (searchProvider: headless-browser; tool-web fetch: true; $WEB_COPY_NOTE)" >&2
  fi
fi
# --- 2f. composition search tool (default-off) -----------------------------
# DSH_SEARCH_COMPOSE=1 mounts plugins/tool-search-compose (issue #40) — the
# grep|head/wc/sort composition layer the transcript measurement demanded.
# The f2972e7 mount crashed every launch because the overlay pointed at the
# BARE IN-TREE PATH (./plugins/tool-search-compose/index.js): it resolves
# relative to the profile directory at boot, and no node_modules sits beside
# a script checkout, so the plugin's bare @deepseek-ai imports had nothing
# to resolve against. The packaging fix is the web-search-browser pattern
# (section 2e): the plugin ships as a real package (package.json + lib/) and
# is COPIED into the profile module tree ($DSH_HOME/profiles/node_modules/
# @dsh-bot/), where @deepseek-ai/dsh-tools and @deepseek-ai/dsh-tool-fs-search
# resolve through the profile's flat fallback (hoisted by the dsh install —
# nothing per-cell to provision, unlike the web provider). The patch overlay
# then names the PACKAGE, never a path. Default off: opt-in per caller, no
# silent fleet-wide flip. Overlay REGENERATED every run (same idempotence
# rule as every stamp in this script); the row rides insert: because a bare
# row with an unknown id only warns and is silently skipped.
COMPOSE_PATCH_FILE=""
if [ "${DSH_SEARCH_COMPOSE:-}" = "1" ]; then
  COMPOSE_PLUGIN_SRC="$SCRIPT_DIR/../plugins/tool-search-compose"
  if [ ! -f "$COMPOSE_PLUGIN_SRC/package.json" ] || [ ! -f "$COMPOSE_PLUGIN_SRC/lib/index.js" ]; then
    echo "error: DSH_SEARCH_COMPOSE=1 but the plugin package is missing or incomplete at $COMPOSE_PLUGIN_SRC (need package.json + lib/index.js)" >&2
    echo "hint: the mount is a packaged plugin, not a bare script path — an incomplete copy is a dead mount, and a dead mount must never look like a working one" >&2
    exit 2
  fi
  mkdir -p "$DSH_HOME/profiles/node_modules/@dsh-bot"
  COMPOSE_PLUGIN_DST="$DSH_HOME/profiles/node_modules/@dsh-bot/tool-search-compose"
  # Same-tree guard (section 2e, review r1 finding 1): structurally
  # unreachable while DSH_HOME is minted or pointed at ~/.dsh, but a
  # DSH_HOME set INSIDE this plugin's directory would otherwise rm -rf the
  # copy's own source before copying from it.
  COMPOSE_SRC_REAL="$(cd "$(dirname "$COMPOSE_PLUGIN_SRC")" && pwd -P)/$(basename "$COMPOSE_PLUGIN_SRC")"
  COMPOSE_DST_REAL="$(cd "$(dirname "$COMPOSE_PLUGIN_DST")" && pwd -P)/$(basename "$COMPOSE_PLUGIN_DST")"
  if [ "$COMPOSE_SRC_REAL" != "$COMPOSE_DST_REAL" ]; then
    rm -rf "$COMPOSE_PLUGIN_DST"
    cp -R "$COMPOSE_PLUGIN_SRC" "$COMPOSE_PLUGIN_DST"
    COMPOSE_COPY_NOTE="plugin copied from $COMPOSE_PLUGIN_SRC"
  else
    COMPOSE_COPY_NOTE="source IS the canonical copy — re-copy skipped (same-tree guard)"
  fi
  COMPOSE_PATCH_FILE="$DSH_HOME/search-compose.patch.yml"
  {
    echo "# Stamped by run-dsh-agent.sh (DSH_SEARCH_COMPOSE=1; regenerated every run)."
    echo "# Composition search tool (issue #40). The package is copied into the profile"
    echo "# module tree above, so its @deepseek-ai deps resolve through the flat fallback;"
    echo "# insert: because a bare row with an unknown id only warns and is silently skipped."
    echo "- insert:"
    echo "    - id: tool-search-compose"
    echo "      name: '@dsh-bot/tool-search-compose'"
  } > "$COMPOSE_PATCH_FILE"
  echo "search-compose: mounted for this run ($COMPOSE_COPY_NOTE)" >&2
fi
# Array + ${arr[@]+...} guard: set -u with an empty array is an error on
# bash 3.2 (the mac cells' /bin/bash) — the guard expands to nothing instead.
DSH_LAUNCH_ARGS=()
if [ -n "$SUBAGENT_PATCH_FILE" ]; then
  DSH_LAUNCH_ARGS+=(--patch "$SUBAGENT_PATCH_FILE")
fi
if [ -n "$WEB_PATCH_FILE" ]; then
  DSH_LAUNCH_ARGS+=(--patch "$WEB_PATCH_FILE")
fi
if [ -n "$COMPOSE_PATCH_FILE" ]; then
  DSH_LAUNCH_ARGS+=(--patch "$COMPOSE_PATCH_FILE")
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
  dsh --profile headless ${DSH_LAUNCH_ARGS[@]+"${DSH_LAUNCH_ARGS[@]}"} "$TASK" >"$FINAL_OUT" &
DSH_PID=$!

stream_session_progress() {
  # $1: marker newer-than, $2: pid of dsh wrapper
  # session_file must be initialized: when the wrapper pid is already dead
  # at the first probe (agent crashed instantly — run 32797020619), the
  # loop breaks before any find assignment and set -u aborts the streamer
  # on an unbound variable instead of degrading gracefully. It was never
  # usefully global anyway: this function runs backgrounded (a subshell),
  # so the parent reads SESSION_PATH_FILE, not this variable.
  local tmp_jsonl seen=0 total session_file=""
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

# `wait ... || RC=$?` (not bare `wait` + RC=$?): under set -e a nonzero
# agent exit aborted the script HERE — before the transcript cleanup below,
# before the final answer was relayed, before the job-scoped home was
# removed. In run 32797020619 the dead agent left its home on the runner.
# The failure must still surface (exit "$RC" at the end), but only AFTER
# cleanup has run.
RC=0
wait "$DSH_PID" || RC=$?
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
