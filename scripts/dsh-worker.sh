#!/usr/bin/env bash
# dsh-worker.sh — the out-of-band worker for the DECOUPLED dsh-bot mode.
#
# The decouple: the comment-triggered loop no longer executes the agent
# inside the Actions job that holds a self-hosted runner for up to 120
# minutes. Instead:
#   - a thin ~20s trigger (agent-comment-thin.yml, github-hosted
#     ubuntu-latest) posts the ack comment and adds the queue label;
#   - THIS worker, running as an always-on process on the factory pool
#     boxes (cron keepalive or systemd — see docs/decoupled-worker.md),
#     polls the queue, claims items, runs the headless agent, ships, and
#     replies — and runs the adversarial review stage inline.
#
# Queue = GitHub-native labels on the target issue/PR:
#   dsh/queued   (added by the trigger; the item is pending)
#   dsh/running  (claim: the worker DELETE-removes queued — the claim is
#                 atomic-ish; a second worker racing the same item gets a
#                 404 on the DELETE and skips it)
#   (completion removes dsh/running; a fresh dsh/queued from a newer
#   trigger comment is left in place for the next sweep)
#
# Usage:
#   dsh-worker.sh --once   one sweep: claim + process every queued item
#   dsh-worker.sh --loop   sweep forever (service mode; --tick N between)
#
# Env contract:
#   GH_TOKEN            required — the worker PAT (read + write on every
#                       configured consumer repo; per-consumer least
#                       privilege is a deployment decision, see docs)
#   DSH_BOT_DIR         required — this toolkit's checkout (scripts/)
#   DSH_WORKER_REPOS    required — space/comma-separated "owner/repo" list
#                       of consumer repos to poll
#   DOPPLER_SERVICE_TOKEN  REQUIRED — the agent launches only via
#                       `doppler run --token ...`; the driver exits 2
#                       (typed) without it. Also used by the
#                       push-credential resolver.
#   DSH_WORKER_DATA_ROOT    run artifacts root (default $HOME/.dsh-worker)
#   DSH_WORKER_MODEL        agent model (default zai/glm-5.3)
#   DSH_WORKER_MODEL_MAP    per-repo model overrides, space-separated
#                       "owner/repo=provider/model" entries — a repo listed
#                       here runs its agents/reviews on that model (restores
#                       consumer-forced lanes like the tower's flash A/B,
#                       which per-consumer workflow inputs used to carry)
#   DSH_WORKER_SUBAGENT_MODEL subagent children (default inherit head)
#   DSH_WORKER_REVIEW_MODEL reviewer model (default $DSH_WORKER_MODEL)
#   DSH_WORKER_REVIEW_RULES_FILE repo-relative rules (default REVIEW.md)
#   DSH_WORKER_QUEUE_LABEL / DSH_WORKER_RUN_LABEL (defaults dsh/queued,
#                       dsh/running)
#   DSH_WORKER_TASK_LABEL   dispatched-task label (default dsh/task) —
#                       task issues created by agent-dispatch-thin.yml;
#                       claimed and run through the agent (the legacy
#                       runner-holding agent-dispatch.yml path, retired)
#   DSH_WORKER_REVIEW_LABEL  review-queue label (default dsh/review) —
#                       review-only items claimed and run through
#                       review-pr.sh (the decoupled review stage)
#   DSH_WORKER_ACK_MARKER   HTML marker the trigger bakes into the ack
#                       comment so the worker can find it (default dsh:ack)
#   DSH_WORKER_TIMEOUT_MIN  per-AGENT-run cap (default 120) — enforced via
#                       GNU `timeout` when present; without it the worker
#                       warns once and runs without a hard cap
#   DSH_WORKER_REVIEW_TIMEOUT_MIN  per-REVIEW cap (default 45, the legacy
#                       agent-review workflow timeout) — same enforcement
#   DSH_WORKER_ORIGIN_PREFIX clone origin prefix (default
#                       https://github.com/ — a TEST SEAM; never set in
#                       production)
#   DSH_WORKER_CONCURRENCY  how many items may run CONCURRENTLY (default
#                       3). Items are independent agent runs; the label
#                       claim is atomic (one DELETE winner), so parallel
#                       items are safe by construction. 1 = the old
#                       strictly-sequential behavior.
#   DSH_WORKER_KEEP_RUNS    how many run dirs to keep (default 10)
#   DSH_WORKER_TICK_S       loop sleep seconds (default 60)
#
# Security posture (the honest delta vs. CI): the worker holds credentials
# BETWEEN tasks — a long-lived BOT_PAT + optional Doppler token in its env
# (see docs/decoupled-worker.md for the env-file + chmod 600 pattern). Per
# TASK, nothing persists: DSH_HOME is job-scoped inside the run dir (the
# driver's existing default), transcripts are deleted, and the run dir is
# pruned. The token NEVER rides argv: git auth rides env-based git config
# (-c would put the value on ps) and the .git/config extraheader written by
# resolve-push-token.sh — the same discipline the CI flow uses.

set -euo pipefail

MODE="${1:---once}"
TICK_S="${DSH_WORKER_TICK_S:-60}"

CHECK_ENV() { # <varname> — required env, typed exit 2 (never run half-configured)
  local v="$1"
  if [ -z "${!v:-}" ]; then echo "dsh-worker: $v unset (required)" >&2; exit 2; fi
}
CHECK_ENV DSH_BOT_DIR
CHECK_ENV GH_TOKEN
CHECK_ENV DSH_WORKER_REPOS
# The driver is always invoked via `bash script` (exec bit not guaranteed
# on checkouts), so `-f`, not `-x`.
[ -f "$DSH_BOT_DIR/scripts/run-dsh-agent.sh" ] \
  || { echo "dsh-worker: no runnable driver at $DSH_BOT_DIR/scripts/run-dsh-agent.sh" >&2; exit 2; }

DATA="${DSH_WORKER_DATA_ROOT:-$HOME/.dsh-worker}"
QUEUE_LABEL="${DSH_WORKER_QUEUE_LABEL:-dsh/queued}"
RUN_LABEL="${DSH_WORKER_RUN_LABEL:-dsh/running}"
REVIEW_LABEL="${DSH_WORKER_REVIEW_LABEL:-dsh/review}"
TASK_LABEL="${DSH_WORKER_TASK_LABEL:-dsh/task}"
ACK_MARKER="${DSH_WORKER_ACK_MARKER:-dsh:ack}"
MODEL="${DSH_WORKER_MODEL:-zai/glm-5.3}"
# model_for <owner/repo> — per-repo override when mapped, else the fleet
# default (charset-validated the same way DSH_MODEL is in the driver).
model_for() {
  local entry
  for entry in ${DSH_WORKER_MODEL_MAP:-}; do
    case "$entry" in
      "$1="*) printf '%s' "${entry#*=}"; return 0 ;;
    esac
  done
  printf '%s' "$MODEL"
}
REVIEW_MODEL="${DSH_WORKER_REVIEW_MODEL:-$MODEL}"
REVIEW_RULES_FILE="${DSH_WORKER_REVIEW_RULES_FILE:-REVIEW.md}"
KEEP_RUNS="${DSH_WORKER_KEEP_RUNS:-10}"
CONCURRENCY="${DSH_WORKER_CONCURRENCY:-3}"
ITEM_SLOTS="$DATA/items"
mkdir -p "$ITEM_SLOTS" 2>/dev/null || true

# slot_free <kind>-<num> — per-item lock + a bounded-slot check. Prints
# the lock path when a slot is taken, nothing when the bound is hit or
# the item is already running.
slot_take() {
  local key="$1" active lock
  lock="$ITEM_SLOTS/$key.lock"
  [ -e "$lock" ] && return 1            # this item is already running
  active="$(ls -1 "$ITEM_SLOTS" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$active" -ge "$CONCURRENCY" ] && return 1
  : > "$lock" 2>/dev/null || return 1
  printf '%s' "$lock"
}
WORKER_NAME="worker-$(hostname -s 2>/dev/null || echo unknown)"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

# Repos → a space list. Accepts comma AND space separators.
REPOS="$(printf '%s' "$DSH_WORKER_REPOS" | tr ',' ' ')"

# label URL segment — label names contain a slash (dsh/queued)
label_enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }

ensure_labels() { # $1 = owner/repo
  local repo="$1" c
  gh label create "$QUEUE_LABEL" --repo "$repo" --force --color FBCA04 --description "dsh task queued (decoupled worker)" >/dev/null 2>&1 || true
  gh label create "$RUN_LABEL"    --repo "$repo" --force --color 0E8A16 --description "dsh task running (decoupled worker)" >/dev/null 2>&1 || true
  gh label create "$REVIEW_LABEL" --repo "$repo" --force --color D93F0B --description "dsh review requested (decoupled worker)" >/dev/null 2>&1 || true
  gh label create "$TASK_LABEL"   --repo "$repo" --force --color 1D76DB --description "dsh dispatched task (decoupled worker)" >/dev/null 2>&1 || true
}

# git auth via ENV-based config (GIT_CONFIG_COUNT): the value rides the
# environment, never argv — argv is ps-readable to any same-user process.
# The header is BASIC auth (base64 x-access-token:TOKEN) — the GitHub-API
# "Authorization: token" scheme 401s on git's http endpoint (proven live on
# seed-dshbot: valid PAT, API calls green, clone 401). Same shape
# resolve-push-token.sh writes. credential.helper is reset so a stale
# helper on a shared box can't inject a dead credential either way.
git_auth_header() { printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"; }
git_clone() { # <owner/repo> <dest>
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="$(git_auth_header)" \
    git -c credential.helper= clone --quiet --depth 1 "https://github.com/${1}.git" "$2"
}

# --- shared repo stores + worktrees (execution isolation) -----------------
# Each served repo gets ONE bare mirror at $DATA/repos/<owner--repo>.git,
# refreshed under a per-repo flock; every item then checks out via
# `git worktree add` — a LOCAL checkout from the shared object store
# instead of a full clone per agent (the tower's pack is ~126MB; at
# concurrency 3 that was 3 clones per sweep). Pushes/fetches from the
# worktree still reach GitHub (the mirror's origin), so shipping is
# unchanged. Any failure falls back to the plain clone.
ORIGIN_PREFIX="${DSH_WORKER_ORIGIN_PREFIX:-https://github.com/}"
repo_store() { # <owner/repo> -> store path (created + refreshed under flock)
  local repo="$1" store lock
  store="$DATA/repos/$(printf '%s' "$repo" | tr '/' '--').git"
  lock="$store.fetch.lock"
  mkdir -p "$DATA/repos" 2>/dev/null || true
  if [ ! -d "$store" ]; then
    ( flock -n 9 || exit 1
      [ -d "$store" ] || git clone --mirror --quiet "${ORIGIN_PREFIX}${repo}.git" "$store"
    ) 9>"$lock" || return 1
  fi
  # bounded refresh: a stale store only costs old refs (items fetch what
  # they need themselves); the lock serializes concurrent sweeps
  ( flock -n 9 && git --git-dir="$store" fetch --prune --quiet origin ) 9>"$lock" 2>/dev/null || true
  printf '%s' "$store"
}

WT_REF_OK=0
git_wt() { # <owner/repo> <dest> [ref] — worktree AT the ref (default HEAD)
  local repo="$1" dest="$2" ref="${3:-HEAD}" store
  WT_REF_OK=0
  store="$(repo_store "$repo")" || { git_clone "$repo" "$dest"; return $?; }
  if git --git-dir="$store" worktree add --detach --quiet "$dest" "$ref" 2>/dev/null; then
    WT_REF_OK=1
    return 0
  fi
  # store present but the ref did not resolve (e.g. a fresh PR whose merge
  # ref postdates the last refresh): refresh once, retry, then fall back
  ( flock -n 9 && git --git-dir="$store" fetch --prune --quiet origin ) 9>"$store.fetch.lock" 2>/dev/null || true
  if git --git-dir="$store" worktree add --detach --quiet "$dest" "$ref" 2>/dev/null; then
    WT_REF_OK=1
    return 0
  fi
  git_clone "$repo" "$dest"
}

wt_prune() { # stale worktree metadata (items rm -rf their dirs)
  local store
  for store in "$DATA"/repos/*.git; do
    [ -d "$store" ] || continue
    git --git-dir="$store" worktree prune 2>/dev/null || true
  done
}

# fetch_context <repo> <num> <outdir> — thread context file (title/body +
# last 8 comments), same shape the CI flow builds. Outdir is REQUIRED (the
# review round caught the redirect landing on $1/repo instead of the run
# dir — the agent was permanently context-blind).
fetch_context() {
  local repo="$1" num="$2" outdir="$3"
  {
    gh issue view "$num" --repo "$repo" \
      --json title,body \
      --jq '"title: " + .title + "\nbody (truncated):\n" + ((.body // "")[0:1600])' || true
    echo
    echo "recent comments (last 8, truncated):"
    gh api "repos/${repo}/issues/${num}/comments?per_page=100" \
      --jq '.[-8:][] | "- " + .user.login + ": " + ((.body // "") | gsub("[\\r\\n]+"; " ") | .[0:280])' || true
  } > "$outdir/thread-context.txt" 2>/dev/null || true
  # AGENT MESSAGES: structured dsh:msg comment blocks become a machine
  # section — agent-to-agent communication over the thread (the schema:
  # <!-- dsh:msg from:<id> to:<id|*> type:<kind> --> ... <!-- /dsh:msg -->).
  gh api "repos/${repo}/issues/${num}/comments?per_page=100" --jq '
    .[] | .body | scan("<!-- dsh:msg[^>]*-->[\\s\\S]*?<!-- /dsh:msg -->") // empty' 2>/dev/null \
    | head -10 > "$outdir/agent-messages.txt" || true
  if [ -s "$outdir/agent-messages.txt" ]; then
    {
      echo
      echo "agent messages on this thread (structured dsh:msg blocks, newest last):"
      cat "$outdir/agent-messages.txt"
    } >> "$outdir/thread-context.txt"
  fi
}

# trusted_task <repo> <num> <is_pr> <outfile> — the task source, in order:
#   1. the last /dsh COMMENT from a trusted author (comments carry their
#      own author_association), then PR review comments;
#   2. the ISSUE BODY when it opens with /dsh and the ISSUE AUTHOR is
#      trusted (minimal issuance: "/dsh " in the body, task = the title);
#   3. the TITLE when it opens with /dsh (title-only issuance).
# Trust is always re-derived from the API — never from the label.
trusted_task() {
  local repo="$1" num="$2" is_pr="$3" out="$4" body issue_json
  body="$(gh api "repos/${repo}/issues/${num}/comments?per_page=100" --jq '
    [.[] | select(((.body // "") | startswith("/dsh")) or ((.body // "") | contains("@dsh-agent")))
          | select(.user.type != "Bot")
          | select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
    ][-1].body // ""' 2>/dev/null || true)"
  if [ -z "$body" ] && [ "$is_pr" = "true" ]; then
    body="$(gh api "repos/${repo}/pulls/${num}/comments?per_page=100" --jq '
      [.[] | select(((.body // "") | startswith("/dsh")) or ((.body // "") | contains("@dsh-agent")))
            | select(.user.type != "Bot")
            | select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
      ][-1].body // ""' 2>/dev/null || true)"
  fi
  if [ -z "$body" ]; then
    # body/title issuance: the ISSUE itself carries the trigger; the issue
    # author's association is the trust (same set as comments). A bare
    # "/dsh" body means "the title IS the task" (#474 shape).
    issue_json="$(gh issue view "$num" --repo "$repo" --json body,title,authorAssociation 2>/dev/null || true)"
    if [ -n "$issue_json" ]; then
      body="$(printf '%s' "$issue_json" | node -e '
        const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const trusted = ["OWNER", "MEMBER", "COLLABORATOR"].includes(j.authorAssociation);
        const body = (j.body || "");
        const title = (j.title || "").replace(/^\/dsh\s*/, "");
        if (!trusted) process.stdout.write("");
        else if (body.startsWith("/dsh")) {
          const t = body.replace(/^\/dsh\s*/, "").trim();
          process.stdout.write(t.length > 0 ? t : "/dsh " + title);
        } else if ((j.title || "").startsWith("/dsh") && title.length > 0) {
          process.stdout.write("/dsh " + title);
        } else process.stdout.write("");' 2>/dev/null || true)"
    fi
  fi
  printf '%s' "$body" > "$out"
}

# ack_comment <repo> <num> — the id of the LAST comment carrying the ack
# marker (the newest trigger's ack; the older arc-editing convention of the
# CI flow collapses to "edit the newest ack in place" here).
ack_comment() {
  local repo="$1" num="$2"
  gh api "repos/${repo}/issues/${num}/comments?per_page=100" \
    --jq "[.[] | select((.body // \"\") | contains(\"${ACK_MARKER}\")) | .id][-1] // 0" 2>/dev/null || echo 0
}

# run_item_bg <slot-key> <func> [args...] — claim a concurrency slot and
# run the item in a background subshell (env-isolated: the item sets its
# own TMPDIR/DSH_HOME inside). The label claim inside the item stays the
# atomic serializer; the slot only bounds how many agents share the box.
# Slot-full is a SKIP, not a failure: the label stays, the next sweep
# retries.
run_item_bg() {
  local key="$1"; shift
  local lock
  lock="$(slot_take "$key")" || { echo "worker: slots full (or $key running) — leaving #$* for the next sweep" >&2; return 0; }
  echo "worker: slot taken ($key); launching in background"
  local ITEM_LOCK="$lock"
  (
    trap 'rm -f "$ITEM_LOCK"' EXIT
    "$@"
  ) &
}

# dashboard_update — the fleet's live status board: ONE issue per repo
# (marker <!-- dsh:dashboard --> in the body, label dsh/dashboard),
# edited each sweep. Queue depth, in-flight runs with their run ids and
# models, slot usage, the live census, recent completions — the answers
# to "what is running right now" on a URL instead of in dispatch logs.
# DSH_WORKER_DASHBOARD=0 disables.
dashboard_update() { # <repo>
  local repo="$1" num body q r inflight slots procs recent
  [ "${DSH_WORKER_DASHBOARD:-1}" = "1" ] || return 0
  num="$(gh issue list --repo "$repo" --state open --label dsh/dashboard --json number --jq '.[0].number' 2>/dev/null || true)"
  if [ -z "$num" ]; then
    num="$(gh issue create --repo "$repo" --title "dsh fleet dashboard" \
      --body "<!-- dsh:dashboard -->\n(initializing…)" --label dsh/dashboard 2>/dev/null | grep -oE '[0-9]+$' || true)"
    [ -n "$num" ] || return 0
  fi
  q="$(gh issue list --repo "$repo" --state open --label dsh/queued --json number --jq 'length' 2>/dev/null || echo '?')"
  r="$(gh issue list --repo "$repo" --state open --label dsh/running --json number --jq 'length' 2>/dev/null || echo '?')"
  slots="$(ls -1 "$ITEM_SLOTS" 2>/dev/null | wc -l | tr -d ' ')"
  procs="$(pgrep -fc 'dsh --profile headless' 2>/dev/null || echo 0)"
  inflight="$(for lk in "$ITEM_SLOTS"/*.lock; do [ -e "$lk" ] || continue; printf '%s ' "$(basename "$lk" .lock)"; done)"
  recent="$(ls -1t "$DATA/runs" 2>/dev/null | head -5 | tr '\n' ' ')"
  body="$(printf '<!-- dsh:dashboard -->
**dsh fleet dashboard** — updated every sweep (~60s) by the worker.

| | |
|---|---|
| queued | %s |
| running | %s |
| slots in use | %s / %s |
| live dsh processes | %s |
| in-flight items | %s |
| recent runs | %s |
| model lanes | fleet=%s map=%s |
' "$q" "$r" "$slots" "$CONCURRENCY" "$procs" "${inflight:-none}" "${recent:-none}" "$MODEL" "${DSH_WORKER_MODEL_MAP:-none}")"
  gh issue edit "$num" --repo "$repo" --body "$body" >/dev/null 2>&1 || true
}

# prune_runs — keep the newest KEEP_RUNS run dirs
prune_runs() {
  [ -d "$DATA/runs" ] || return 0
  ls -1t "$DATA/runs" | tail -n +$((KEEP_RUNS + 1)) | while read -r d; do rm -rf "$DATA/runs/$d"; done
  wt_prune
}

# abort_item <repo> <num> <rundir> <stage> — a claimed task that dies before
# reaching the agent must NOT vanish silently: post a short note on the
# thread (the review round called this out — post-claim aborts dropped the
# task with zero UI), then release the run label and drop the run dir.
abort_item() {
  local repo="$1" num="$2" rundir="$3" stage="$4"
  printf '**dsh agent** — this task failed in the worker before reaching the agent (stage: %s). Nothing was changed or shipped. Check the worker log and retry with a new `/dsh` comment.' "$stage" \
    > "$rundir/aborted.md"
  gh api "repos/${repo}/issues/${num}/comments" -f body="$(cat $rundir/aborted.md)" >/dev/null 2>&1 || true
  gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$RUN_LABEL")" >/dev/null 2>&1 || true
  rm -rf "$rundir"
}

# review_item <repo> <num> — a REVIEW-ONLY queue item (the dsh/review
# label, added by the thin review trigger on a /review comment or a
# workflow_dispatch). This is the decoupled replacement for the legacy
# agent-review.yml path: the review of ANY PR runs on the worker, and no
# Actions job ever holds a self-hosted runner for it. Claim semantics are
# the label-DELETE race as agent tasks.
review_item() {
  local repo="$1" num="$2" runid rundir work rc
  runid="r$(date +%Y%m%d-%H%M%S)-$$"
  rundir="$DATA/runs/$runid"
  work="$rundir/repo"
  mkdir -p "$rundir/tmp" "$work"
  export TMPDIR="$rundir/tmp"
  echo "==== worker [$runid] REVIEW $repo #$num ===="

  # claim: remove the review label; 404 = another worker took it
  if ! gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$REVIEW_LABEL")" >/dev/null 2>&1; then
    echo "worker: review claim lost on $repo #$num (label gone) — skip"
    rm -rf "$rundir"
    return 0
  fi

  # worktree from the shared store at the default branch; review-pr.sh
  # fetches the PR merge ref + base ref itself and diffs base...merge
  # inside it. ANY failure after claim notes the thread and leaves the
  # label OFF — including checkout failures (drift finding 2 on v1.46.0: silent drops). No
  # auto-requeue anywhere: an unconditional re-queue on a persistently
  # failing clone would post one comment per sweep, forever (self-caught
  # during this PR's review); a human re-fires /review instead.
  git_wt "$repo" "$work" "HEAD" \
    || { echo "worker: review checkout failed on $repo — noting the thread, no auto-requeue" >&2
         printf '**dsh review** — the worker could not clone the repo for this review (clone/egress failure). The review item was dropped (no auto-retry); re-run with `/review` to retry.' > "$rundir/clone-failed.md"
         gh api "repos/${repo}/issues/${num}/comments" -f body="$(cat $rundir/clone-failed.md)" >/dev/null 2>&1 || true
         rm -rf "$rundir"; return 1; }

  # Hard cap: reviews default to 45m (the legacy agent-review workflow's
  # own timeout) via DSH_WORKER_REVIEW_TIMEOUT_MIN — agent tasks keep their
  # separate DSH_WORKER_TIMEOUT_MIN (drift INFO note 4 on v1.46.0: one
  # env, two very different legacy budgets).
  REVIEW_TIMEOUT_ARGS=()
  if command -v timeout >/dev/null 2>&1; then
    REVIEW_TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=60 "${DSH_WORKER_REVIEW_TIMEOUT_MIN:-45}m")
  else
    echo "worker: GNU timeout unavailable — review runs without a hard cap (provision the box)" >&2
  fi
  rc=0
  ITEM_REVIEW_MODEL="$(model_for "$repo")"
  "${REVIEW_TIMEOUT_ARGS[@]+"${REVIEW_TIMEOUT_ARGS[@]}"}" \
    env DSH_SHIP_REPO="$repo" DSH_REVIEW_OUT="$rundir/review-output.txt" DSH_REVIEW_MODEL="$ITEM_REVIEW_MODEL" \
    DSH_REVIEW_RULES_FILE="$REVIEW_RULES_FILE" DSH_WORKTREE="$work" PR_NUM="$num" \
    DSH_RUN_ID="$runid" DSH_RUNNER_NAME="$WORKER_NAME" \
    bash "$DSH_BOT_DIR/scripts/review-pr.sh" || rc=$?
  echo "worker: review of $repo #$num exited $rc (verdicts never auto-approve; see the PR thread)"
  if [ "$rc" -ne 0 ]; then
    # Mid-review failure (timeout=124, crash, typed exit): the label stays
    # OFF (no auto-retry — a systemic failure must not loop the worker),
    # but the drop is NEVER silent: the thread gets a note and a human can
    # re-fire /review (drift finding 2 on v1.46.0).
    printf '**dsh review** — the worker review of this PR failed before producing a verdict (worker exit %s, run %s). No labels were changed. Re-run with `/review` to retry.' "$rc" "$runid" > "$rundir/review-failed.md"
    gh api "repos/${repo}/issues/${num}/comments" -f body="$(cat $rundir/review-failed.md)" >/dev/null 2>&1 || true
  fi
  rm -rf "$rundir"
  prune_runs
}

# task_item <repo> <num> — a DISPATCHED TASK item (the dsh/task label on
# an issue created by agent-dispatch-thin.yml). The task text and its
# options ride the issue body as a structured marker block; the marker is
# provenance (written by the privileged trigger), and an issue without it
# is NOT a task. Semantics match the legacy agent-dispatch path: the agent
# pushes/opens PRs itself (no shipper step, no comment-bot mode), and its
# final answer is posted back on the task issue, which is then closed.
task_item() {
  local repo="$1" num="$2" runid rundir work rc title body task t_model t_sub t_base
  runid="t$(date +%Y%m%d-%H%M%S)-$$"
  rundir="$DATA/runs/$runid"
  work="$rundir/repo"
  mkdir -p "$rundir/tmp" "$work"
  export TMPDIR="$rundir/tmp"
  echo "==== worker [$runid] TASK $repo #$num ===="

  # claim: remove the task label; 404 = another worker took it
  if ! gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$TASK_LABEL")" >/dev/null 2>&1; then
    echo "worker: task claim lost on $repo #$num (label gone) — skip"
    rm -rf "$rundir"
    return 0
  fi

  body="$(gh issue view "$num" --repo "$repo" --json body --jq .body 2>/dev/null || true)"
  if ! printf '%s' "$body" | grep -q '<!-- dsh:task'; then
    # not a trigger-created task: relabel loudly, never run arbitrary bodies
    echo "worker: $repo #$num carries $TASK_LABEL without the dsh:task marker — not a dispatched task; label dropped" >&2
    printf '**dsh worker** — this issue carried the task label without the trigger marker; nothing was run. Dispatch tasks come from the agent-dispatch trigger.'       > "$rundir/not-a-task.md"
    gh api "repos/${repo}/issues/${num}/comments" -f body="$(cat "$rundir/not-a-task.md")" >/dev/null 2>&1 || true
    rm -rf "$rundir"
    return 0
  fi

  # parse the marker block (key: value) and strip it from the task text
  t_model="$(printf '%s' "$body" | sed -n 's/^model: //p' | head -n1)"
  t_sub="$(printf '%s' "$body" | sed -n 's/^subagent-model: //p' | head -n1)"
  t_base="$(printf '%s' "$body" | sed -n 's/^base-ref: //p' | head -n1)"
  task="$(printf '%s' "$body" | sed -n '/^ -->$/,$p' | tail -n +2 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$task" ]; then
    echo "worker: task issue $repo #$num has an empty task body — closing with a note" >&2
    gh api "repos/${repo}/issues/${num}/comments" -f body="**dsh worker** — the dispatched task carried no task text; nothing was run." >/dev/null 2>&1 || true
    gh issue close "$num" --repo "$repo" >/dev/null 2>&1 || true
    rm -rf "$rundir"
    return 0
  fi

  # model resolution: the task's explicit model > the repo map > fleet default
  ITEM_MODEL="${t_model:-$(model_for "$repo")}"

  # checkout: default branch (worktree from the shared store), or the
  # requested ref when present in the store
  if [ -n "$t_base" ]; then
    git_wt "$repo" "$work" "refs/heads/$t_base" || git_wt "$repo" "$work" "HEAD"
  else
    git_wt "$repo" "$work" "HEAD"
  fi
  rc_wt=$?
  [ "$rc_wt" -eq 0 ] \
    || { echo "worker: task checkout failed on $repo — noting the thread, no auto-retry" >&2
         gh api "repos/${repo}/issues/${num}/comments" -f body="**dsh worker** — the checkout for this dispatched task failed (clone/egress); the task was dropped. Re-dispatch to retry." >/dev/null 2>&1 || true
         gh issue close "$num" --repo "$repo" >/dev/null 2>&1 || true
         rm -rf "$rundir"; return 1; }
  if [ -n "$t_base" ] && git -C "$work" -c credential.helper= fetch -q --depth 1 origin "refs/heads/${t_base}:refs/remotes/origin/taskbase" 2>/dev/null; then
    git -C "$work" checkout -q refs/remotes/origin/taskbase \
      || echo "worker: base-ref '$t_base' checkout fell back to the default branch" >&2
  fi

  # push credential (the agent pushes itself in dispatch mode)
  ( cd "$work" && PUSH_FALLBACK_CRED="$GH_TOKEN" DOPPLER_SERVICE_TOKEN="${DOPPLER_SERVICE_TOKEN:-}" \
      bash "$DSH_BOT_DIR/scripts/resolve-push-token.sh" ) \
    || { echo "worker: task push-credential write failed — aborting" >&2
         gh api "repos/${repo}/issues/${num}/comments" -f body="**dsh worker** — the push credential could not be written for this task; nothing ran. Re-dispatch to retry." >/dev/null 2>&1 || true
         rm -rf "$rundir"; return 1; }

  # run the agent (dispatch semantics: REPLY_TARGET empty — the agent may
  # push and open PRs itself; its final answer is posted by the worker)
  TIMEOUT_ARGS=()
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=60 "${DSH_WORKER_TIMEOUT_MIN:-120}m")
  else
    echo "worker: GNU timeout unavailable — task runs without a hard cap (provision the box)" >&2
  fi
  # The export MUST terminate before the command (the && is load-bearing):
  # a backslash continuation made "bash <driver> <task>" ARGUMENTS OF
  # EXPORT — the driver never ran at all (live on the box: instant empty
  # reply). `|| rc=$?` (not bare rc=$?): the sweep calls task_item in an
  # || context, which suppresses set -e inside the function — a failing
  # pipeline must be captured, never flow into the reply step.
  rc=0
  ( cd "$work" && export DSH_MODEL="$ITEM_MODEL" DSH_SUBAGENT_MODEL="${t_sub:-}" REPLY_TARGET="" DSH_BOT_DIR="$DSH_BOT_DIR" DSH_RUNNER_NAME="$WORKER_NAME" \
      && "${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"}" bash "$DSH_BOT_DIR/scripts/run-dsh-agent.sh" "$task" ) \
    | node "$DSH_BOT_DIR/scripts/scrub-output.mjs" | tee "$rundir/agent-output.txt" >/dev/null || rc=$?
  echo "worker: task agent exited $rc"

  # reply on the task issue and close it (the answer is the record)
  DSH_SHIP_REPO="$repo" DSH_SHIP_CACHE="$rundir" DSH_AGENT_OUTPUT="$rundir/agent-output.txt" \
    TARGET_KIND="issue" TARGET_NUM="$num" DSH_RUN_ID="$runid" DSH_RUNNER_NAME="$WORKER_NAME" \
    bash "$DSH_BOT_DIR/scripts/post-reply.sh" \
    || echo "worker: task reply step failed (the answer is in the run log)" >&2
  gh issue close "$num" --repo "$repo" >/dev/null 2>&1 || true
  echo "==== worker [$runid] TASK $repo #$num complete ===="
  prune_runs
}

# process_item <repo> <num> <is_pr>
process_item() {
  local repo="$1" num="$2" is_pr="$3" kind runid rundir work task raw body thread ackid rc
  kind="issue"; [ "$is_pr" = "true" ] && kind="pr"
  runid="w$(date +%Y%m%d-%H%M%S)-$$"
  rundir="$DATA/runs/$runid"
  work="$rundir/repo"
  # ctx MUST exist before fetch_context redirects into it (review round 2 on
  # PR #50: the F3 fix pointed the redirect at $rundir/ctx but nothing ever
  # created the dir — still context-blind under || true).
  mkdir -p "$rundir/tmp" "$rundir/ctx" "$work"
  export TMPDIR="$rundir/tmp"
  echo "==== worker [$runid] $repo #$num ($kind) ===="

  # --- claim: remove the queued label; 404 = another worker took it ------
  if ! gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$QUEUE_LABEL")" >/dev/null 2>&1; then
    echo "worker: claim lost on $repo #$num (queued label gone) — skip"
    rm -rf "$rundir"
    return 0
  fi
  gh api -X POST "repos/${repo}/issues/${num}/labels" -f labels[]="$RUN_LABEL" >/dev/null 2>&1 || true

  # --- thread context + task + ack pointer --------------------------------
  fetch_context "$repo" "$num" "$rundir/ctx"
  trusted_task "$repo" "$num" "$is_pr" "$rundir/task.raw"
  raw="$(cat "$rundir/task.raw" 2>/dev/null || true)"
  if [ -z "$raw" ]; then
    echo "worker: no trusted /dsh comment found on $repo #$num — replying and closing the item"
    printf '**dsh agent** — no trusted `/dsh` comment found on this thread (the trigger comment must come from an OWNER/MEMBER/COLLABORATOR and start with `/dsh` or `@dsh-agent`).' \
      > "$rundir/nothing-to-do.md"
    gh api "repos/${repo}/issues/${num}/comments" -f body="$(cat $rundir/nothing-to-do.md)" >/dev/null 2>&1 || true
    gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$RUN_LABEL")" >/dev/null 2>&1 || true
    rm -rf "$rundir"
    return 0
  fi
  TASK="${raw#/dsh }"
  TASK="${TASK#@dsh-agent }"
  TASK="${TASK#@dsh-agent: }"
  TASK="$(printf '%s' "$TASK" | sed -E 's/^--(big|mac|linux)([[:space:]]+|$)//' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$TASK" ]; then
    echo "worker: empty task after stripping the trigger (bare /dsh) — replying and closing the item"
    printf '**dsh agent** — the trigger comment had no task text after the `/dsh` prefix; nothing to do.' \
      > "$rundir/empty-task.md"
    gh api "repos/${repo}/issues/${num}/comments" -f body="$(cat $rundir/empty-task.md)" >/dev/null 2>&1 || true
    gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$RUN_LABEL")" >/dev/null 2>&1 || true
    rm -rf "$rundir"
    return 0
  fi
  THREAD_CONTEXT="$(cat "$rundir/ctx/thread-context.txt" 2>/dev/null || true)"
  ACK_ID="$(ack_comment "$repo" "$num")"
  [ "$ACK_ID" = "0" ] && ACK_ID=""

  # --- checkout the target ref (PR merge ref for PR comments) -------------
  {
    if [ "$kind" = "pr" ]; then
      git_wt "$repo" "$work" "refs/pull/${num}/merge"
      if [ "$WT_REF_OK" != "1" ]; then
        GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
          GIT_CONFIG_VALUE_0="$(git_auth_header)" \
          git -C "$work" -c credential.helper= fetch -q --depth 1 origin "refs/pull/${num}/merge"
        git -C "$work" checkout -q FETCH_HEAD
      fi
    else
      git_wt "$repo" "$work" "HEAD"
    fi
  } || { echo "worker: checkout failed on $repo (token scope?) — aborting item" >&2; abort_item "$repo" "$num" "$rundir" "checkout of the target ref"; return 1; }

  # --- push credential into the clone (same resolver the CI flow uses) ----
  ( cd "$work" && PUSH_FALLBACK_CRED="$GH_TOKEN" DOPPLER_SERVICE_TOKEN="${DOPPLER_SERVICE_TOKEN:-}" \
      bash "$DSH_BOT_DIR/scripts/resolve-push-token.sh" ) \
    || { echo "worker: push-credential write failed — aborting item" >&2; abort_item "$repo" "$num" "$rundir" "push-credential write (resolve-push-token.sh)"; return 1; }

  # --- before-state for the shipper ----------------------------------------
  git -C "$work" rev-parse HEAD > "$rundir/dsh-before-sha"
  git -C "$work" ls-remote origin 'refs/heads/dsh/*' 2>/dev/null | awk '{print $2}' \
    | sed 's|refs/heads/||' | sort > "$rundir/dsh-before-dsh-branches" || true
  gh pr list --repo "$repo" --state open --limit 100 --json number --jq '.[].number' \
    | sort -n > "$rundir/dsh-before-open-prs" || true

  # --- run the agent (driver unchanged; comment-bot mode via REPLY_TARGET)-
  TIMEOUT_ARGS=()
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=60 "${DSH_WORKER_TIMEOUT_MIN:-120}m")
  else
    echo "worker: GNU timeout unavailable — running without a hard per-task cap (set DSH_WORKER_TIMEOUT_MIN + provision the box)" >&2
  fi
  rc=0
  ITEM_MODEL="$(model_for "$repo")"
  # Same two rules as task_item: the export terminates with && (never a
  # backslash continuation into the command — that made the driver an
  # argument of export), and the pipeline's rc is captured with || rc=$?
  # (the || call context suppresses set -e inside this function).
  ( cd "$work" && export THREAD_CONTEXT REPLY_TARGET="$kind #$num" DSH_MODEL="$ITEM_MODEL" DSH_BOT_DIR="$DSH_BOT_DIR" DSH_RUNNER_NAME="$WORKER_NAME" \
      && "${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"}" bash "$DSH_BOT_DIR/scripts/run-dsh-agent.sh" "$TASK" ) \
    | node "$DSH_BOT_DIR/scripts/scrub-output.mjs" | tee "$rundir/agent-output.txt" >/dev/null || rc=$?
  echo "worker: agent exited $rc (non-zero is the agent/task failing, not the worker)"

  # --- ship (deterministic; shared script) ---------------------------------
  # DSH_SHIP_NOTE_FILE is deliberately NOT set: the default
  # ($DSH_SHIP_CACHE/dsh-ship-note.txt) is exactly what post-reply.sh reads
  # — a custom filename here silently dropped the Shipped note from the
  # worker's reply (review round 2 on PR #50).
  ( cd "$work" && ACK_COMMENT_ID="$ACK_ID" DSH_SHIP_REPO="$repo" DSH_RUN_ID="$runid" DSH_RUN_ATTEMPT=1 \
      DSH_WORKTREE="$work" DSH_SHIP_CACHE="$rundir" DSH_AGENT_OUTPUT="$rundir/agent-output.txt" \
      DSH_PR_NUM_FILE="$rundir/pr-num" REVIEW_WORKFLOW="" \
      DSH_TASK_TITLE="${TASK%%$'\n'*}" bash "$DSH_BOT_DIR/scripts/ship-changes.sh" ) \
    || echo "worker: shipper exited nonzero (see log — ship note may be incomplete)" >&2

  # --- reply (edits the trigger's ack comment in place when found) ---------
  # (DSH_SHIP_REPO is a REQUIRED env guard in post-reply.sh — without it
  # every task died at the reply step; review round on PR #45.)
  DSH_SHIP_REPO="$repo" DSH_SHIP_CACHE="$rundir" DSH_AGENT_OUTPUT="$rundir/agent-output.txt" \
    ACK_COMMENT_ID="$ACK_ID" \
    TARGET_KIND="$kind" TARGET_NUM="$num" DSH_RUN_ID="$runid" DSH_RUNNER_NAME="$WORKER_NAME" \
    bash "$DSH_BOT_DIR/scripts/post-reply.sh" || echo "worker: reply step failed" >&2

  # --- adversarial review of what shipped (inline, on the worker) ----------
  if [ -s "$rundir/pr-num" ]; then
    PR_NUM="$(cat "$rundir/pr-num")"
    echo "worker: reviewing shipped PR #$PR_NUM (model $REVIEW_MODEL)"
    DSH_SHIP_REPO="$repo" DSH_REVIEW_OUT="$rundir/review-output.txt" DSH_REVIEW_MODEL="$REVIEW_MODEL" \
      DSH_REVIEW_RULES_FILE="$REVIEW_RULES_FILE" DSH_WORKTREE="$work" PR_NUM="$PR_NUM" \
      DSH_RUN_ID="$runid" DSH_RUNNER_NAME="$WORKER_NAME" \
      bash "$DSH_BOT_DIR/scripts/review-pr.sh" \
      || echo "worker: review stage exited nonzero (see log; verdicts never auto-approve)" >&2
  else
    echo "worker: nothing shipped — no review stage"
  fi

  # --- close the item: running → (queued stays if a newer trigger re-added)
  gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$RUN_LABEL")" >/dev/null 2>&1 || true
  echo "==== worker [$runid] $repo #$num complete ===="
  prune_runs
}

sweep() {
  local repo line num is_pr
  for repo in $REPOS; do
    ensure_labels "$repo"
    echo "worker: polling $repo for label '$QUEUE_LABEL'"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      num="$(printf '%s' "$line" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).number?.toString() ?? "")')"
      is_pr="$(printf '%s' "$line" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).is_pr))')"
      [ -n "$num" ] || continue
      run_item_bg "w-$repo-$num" process_item "$repo" "$num" "$is_pr"
    done < <(gh api --paginate "repos/${repo}/issues?state=open&labels=${QUEUE_LABEL}&per_page=100" \
      --jq '.[] | {number: (.number // 0), is_pr: ((.pull_request != null) // false)}' \
      || echo "worker: poll FAILED for $repo label '$QUEUE_LABEL' (gh error above, if any)" >&2)
    # Review-only items (dsh/review): the decoupled review stage — reviews
    # of ANY PR run here, never in a runner-holding Actions job.
    echo "worker: polling $repo for label '$REVIEW_LABEL'"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      num="$(printf '%s' "$line" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).number?.toString() ?? "")')"
      is_pr="$(printf '%s' "$line" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).is_pr))')"
      [ -n "$num" ] || continue
      if [ "$is_pr" = "true" ]; then
        run_item_bg "r-$repo-$num" review_item "$repo" "$num"
      else
        echo "worker: dsh/review on $repo #$num is not a PR — dropping the label (reviews are PR-only)"
        gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$REVIEW_LABEL")" >/dev/null 2>&1 || true
      fi
    done < <(gh api --paginate "repos/${repo}/issues?state=open&labels=${REVIEW_LABEL}&per_page=100" \
      --jq '.[] | {number: (.number // 0), is_pr: ((.pull_request != null) // false)}' \
      || echo "worker: poll FAILED for $repo label '$REVIEW_LABEL' (gh error above, if any)" >&2)
    # Dispatched tasks (dsh/task): the legacy runner-holding
    # agent-dispatch path, retired — tasks run here like everything else.
    echo "worker: polling $repo for label '$TASK_LABEL'"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      num="$(printf '%s' "$line" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).number?.toString() ?? "")')"
      is_pr="$(printf '%s' "$line" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).is_pr))')"
      [ -n "$num" ] || continue
      if [ "$is_pr" = "true" ]; then
        echo "worker: dsh/task on $repo #$num is a PR — dropping the label (tasks are issue-only)"
        gh api -X DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$TASK_LABEL")" >/dev/null 2>&1 || true
      else
        run_item_bg "t-$repo-$num" task_item "$repo" "$num"
      fi
    done < <(gh api --paginate "repos/${repo}/issues?state=open&labels=${TASK_LABEL}&per_page=100" \
      --jq '.[] | {number: (.number // 0), is_pr: ((.pull_request != null) // false)}' \
      || echo "worker: poll FAILED for $repo label '$TASK_LABEL' (gh error above, if any)" >&2)

    dashboard_update "$repo"
  done
}

case "$MODE" in
  --once)
    sweep
    ;;
  --loop)
    echo "dsh-worker: loop mode — sweeping every ${TICK_S}s (PID $$, data root $DATA)"
    while true; do
      sweep
      sleep "$TICK_S"
    done
    ;;
  *)
    echo "usage: dsh-worker.sh [--once|--loop]  (see header comments for env contract)" >&2
    exit 2
    ;;
esac