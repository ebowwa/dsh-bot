#!/usr/bin/env bash
# ship-changes.sh — the deterministic shipper, shared by the comment workflow
# (agent-comment.yml) and the out-of-band worker (dsh-worker.sh).
#
# "Deterministic shipping (never trust the model to push)": after an agent
# run, diff the repo state the agent worked on vs. the state captured before
# the run and open PRs for anything new — branches the agent pushed under
# dsh/* and local changes/commits the shipper commits itself. The model is
# never given push authority; this script is the only pusher.
#
# Runs in the caller's context: caller's repo checkout, caller's GH_TOKEN.
# In the comment workflow the caller is the Actions job; in decoupled mode
# the caller is the worker's per-task clone. Both call this exact script.
#
# Env contract (Actions names are ambient when running there; DSH_* names
# make the script runnable anywhere):
#   GH_TOKEN                required — the push + gh identity
#   DSH_SHIP_REPO           repo to ship to (default $GITHUB_REPOSITORY)
#   DSH_RUN_ID              run identifier for branch naming (default $GITHUB_RUN_ID)
#   DSH_RUN_ATTEMPT         attempt counter (default ${GITHUB_RUN_ATTEMPT:-1})
#   DSH_WORKTREE            the checkout the agent worked in (default $GITHUB_WORKSPACE)
#   DSH_BOT_DIR             dsh-bot toolkit checkout (contains scripts/)
#   DSH_SHIP_CACHE          dir holding the BEFORE-state files this script
#                           diffs against; the caller (workflow step or
#                           worker) must have written them. Default
#                           ${RUNNER_TEMP:-/tmp}.
#   DSH_AGENT_OUTPUT        path of the tee'd (unscrubbed-on-disk) agent
#                           output, re-scrubbed here for PR bodies
#                           (default $DSH_SHIP_CACHE/dsh-agent-output.txt).
#   DSH_SHIP_NOTE_FILE      where the human "shipped: ..." note goes
#                           (default $DSH_SHIP_CACHE/dsh-ship-note.txt).
#   DSH_PR_NUM_FILE         optional: first reviewable PR number opened is
#                           written here (the worker's review stage reads it).
#   DSH_TASK_TITLE          optional title seed for PRs.
#   ACK_COMMENT_ID          optional: ack comment to PATCH to "shipping".
#   REVIEW_WORKFLOW         optional: workflow filename to dispatch per PR
#                           (empty/absent = worker mode: no dispatch — the
#                           worker reviews inline).
#   EXTRA_SCRUB_HOSTS       optional comma-separated hosts for the scrubber
#                           (mapped to DSH_SCRUB_EXTRA_HOSTS like the driver
#                           does).
#
# BEFORE-state files the CALLER must have captured before the agent ran
# (identical to the workflow's old inline capture):
#   $DSH_SHIP_CACHE/dsh-before-sha            HEAD before the run
#   $DSH_SHIP_CACHE/dsh-before-dsh-branches   remote dsh/* branches before
#   $DSH_SHIP_CACHE/dsh-before-open-prs       open PR numbers before

set -uo pipefail

DSH_SHIP_REPO="${DSH_SHIP_REPO:-${GITHUB_REPOSITORY:?ship-changes: DSH_SHIP_REPO/GITHUB_REPOSITORY unset}}"
DSH_RUN_ID="${DSH_RUN_ID:-${GITHUB_RUN_ID:?ship-changes: DSH_RUN_ID/GITHUB_RUN_ID unset}}"
DSH_RUN_ATTEMPT="${DSH_RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-1}}"
DSH_WORKTREE="${DSH_WORKTREE:-${GITHUB_WORKSPACE:?ship-changes: DSH_WORKTREE/GITHUB_WORKSPACE unset}}"
DSH_BOT_DIR="${DSH_BOT_DIR:?ship-changes: DSH_BOT_DIR unset}"
DSH_SHIP_CACHE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}"
DSH_AGENT_OUTPUT="${DSH_AGENT_OUTPUT:-$DSH_SHIP_CACHE/dsh-agent-output.txt}"
DSH_SHIP_NOTE_FILE="${DSH_SHIP_NOTE_FILE:-$DSH_SHIP_CACHE/dsh-ship-note.txt}"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

cd "$DSH_WORKTREE" || { echo "ship-changes: cannot cd to $DSH_WORKTREE" >&2; exit 2; }

# gh may sit outside the runner service PATH on self-hosted cells (secondsee
# lane-lottery, 2026-08-26): probe the driver's persistent prefix + brew
# prefixes before giving up. Identical list to the driver's CELL_PROBE_DIRS.
command -v gh >/dev/null 2>&1 \
  || export PATH="${DSH_CELL_BIN:-${HOME:-/root}/.dsh-bot-bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.doppler/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

# Progress edit: agent phase over, shipping.
if [ -n "${ACK_COMMENT_ID:-}" ] && command -v gh >/dev/null 2>&1; then
  gh api "repos/${DSH_SHIP_REPO}/issues/comments/${ACK_COMMENT_ID}" -X PATCH \
    -f body="**dsh agent (GLM-5.3)** — run: ${DSH_RUN_ID} — lane: ${DSH_RUNNER_NAME:-unknown}

  :package: Agent finished — shipping any changes." >/dev/null 2>&1 || true
fi

NOTE=""

# open_pr <head-branch> <title> <gh-pr-create args...>: create the PR and
# dispatch its review with the same degrade-or-loud treatment as the
# relay/reply guards — gh missing is a ::warning:: plus a precise ship note
# AFTER a successful push, never a bare 127 that leaves "branch pushed, no
# PR, no review" recorded only as a generic failure (review r2 finding 5).
open_pr() {
  local head_b="$1" title="$2" PR_OUT PR_NUM
  shift 2
  if ! command -v gh >/dev/null 2>&1; then
    echo "::warning::gh unavailable — $head_b pushed, PR NOT opened (open it from the branch); no review dispatched" >&2
    echo "pushed $head_b (gh unavailable: PR not opened)"
    return 0
  fi
  PR_OUT="$(gh pr create --repo "$DSH_SHIP_REPO" --head "$head_b" \
    --title "$title" "$@" 2>&1 || true)"
  case "$PR_OUT" in
    https://*)
      PR_NUM="$(gh pr view "$head_b" --repo "$DSH_SHIP_REPO" --json number --jq .number 2>/dev/null || true)"
      if [ -n "$PR_NUM" ] && [ -n "${DSH_PR_NUM_FILE:-}" ] && [ ! -f "$DSH_PR_NUM_FILE" ]; then
        echo "$PR_NUM" > "$DSH_PR_NUM_FILE" 2>/dev/null || true
      fi
      if [ -n "$PR_NUM" ] && [ -n "${REVIEW_WORKFLOW:-}" ]; then
        if gh workflow run "$REVIEW_WORKFLOW" --repo "$DSH_SHIP_REPO" -f pr="$PR_NUM" 2>/dev/null; then
          echo "shipped [$head_b]($PR_OUT); review dispatched"
        else
          echo "review dispatch failed for #$PR_NUM (run: gh workflow run $REVIEW_WORKFLOW -f pr=$PR_NUM)" >&2
          echo "shipped [$head_b]($PR_OUT)"
        fi
      else
        echo "shipped [$head_b]($PR_OUT)"
      fi;;
    *)
      echo "gh pr create failed for $head_b: $PR_OUT" >&2
      echo "pushed $head_b (PR create failed: $(echo "$PR_OUT" | head -n1))";;
  esac
}

command -v git >/dev/null 2>&1 || { echo "no git; skip"; echo "" > "$DSH_SHIP_NOTE_FILE"; exit 0; }
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
BEFORE_SHA="$(cat "$DSH_SHIP_CACHE/dsh-before-sha" 2>/dev/null || git rev-parse HEAD)"
git fetch origin --prune --quiet 2>/dev/null || true

if [ -s "$DSH_SHIP_CACHE/dsh-before-open-prs" ] && command -v gh >/dev/null 2>&1; then
  while read -r N; do
    ST="$(gh pr view "$N" --repo "$DSH_SHIP_REPO" --json state --jq .state 2>/dev/null || true)"
    case "$ST" in
      MERGED) NOTE="${NOTE:+$NOTE; }merged #$N";;
      CLOSED) NOTE="${NOTE:+$NOTE; }closed #$N";;
    esac
  done < "$DSH_SHIP_CACHE/dsh-before-open-prs"
fi

git ls-remote origin 'refs/heads/dsh/*' 2>/dev/null | awk '{print $2}' \
  | sed 's|refs/heads/||' | sort > "$DSH_SHIP_CACHE/dsh-after-dsh-branches" || true
NEW_REMOTE="$(comm -13 "$DSH_SHIP_CACHE/dsh-before-dsh-branches" "$DSH_SHIP_CACHE/dsh-after-dsh-branches" 2>/dev/null || true)"
if [ -n "$NEW_REMOTE" ]; then
  NOTE="agent pushed: $(echo "$NEW_REMOTE" | tr '\n' ' ')"
fi

for B in $(git for-each-ref refs/heads/dsh --format='%(refname:short)'); do
  if ! grep -qx "$B" "$DSH_SHIP_CACHE/dsh-after-dsh-branches" 2>/dev/null; then
    if git push -u origin "$B" 2>&1; then
      NOTE="${NOTE:+$NOTE; }$(open_pr "$B" "dsh: ${DSH_TASK_TITLE:-$B}" \
        --body "Automated PR from agent run ${DSH_RUN_ID} (branch pushed by shipper).")"
    fi
  fi
done

# .dsh-bot is the fetched toolkit checkout, NOT agent work (workflow mode);
# the worker's clone contains no toolkit checkout at all, so the exclusion is
# harmless there. DIFF_OK tracks whether the git checks ACTUALLY ran — a
# failing git must never yield a "verified: nothing to ship" note (review
# round on PR #45: the unguarded substitutions collapsed failures to an
# empty diff and the note overclaimed verification).
DIFF_OK=1
DIRTY="$(git status --porcelain -- . ':!.dsh-bot' 2>/dev/null)" || DIFF_OK=0
AHEAD="$(git log --oneline "$BEFORE_SHA..HEAD" 2>/dev/null | wc -l | tr -d ' ')" || DIFF_OK=0
if [ -n "$DIRTY" ] || [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null; then
  BRANCH="dsh/auto-r${DSH_RUN_ID}a${DSH_RUN_ATTEMPT}"
  git checkout -B "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"
  if [ -n "$DIRTY" ]; then
    git add -A -- . ':!.dsh-bot'
    git commit -m "dsh: automated ship of agent run ${DSH_RUN_ID}" --allow-empty 2>/dev/null || true
  fi
  if git push -u origin "$BRANCH" 2>&1; then
    {
      echo "Automated PR from **dsh agent (GLM-5.3)** run ${DSH_RUN_ID}."
      echo
      echo "**Task:** ${DSH_TASK_TITLE:-_(see run log)_}"
      echo
      echo "---"
      echo
      if [ -f "$DSH_AGENT_OUTPUT" ]; then
        node "$DSH_BOT_DIR/scripts/scrub-output.mjs" < "$DSH_AGENT_OUTPUT" 2>/dev/null || true
      fi
    } > "$DSH_SHIP_CACHE/dsh-pr-body.md"
    NOTE="${NOTE:+$NOTE; }$(open_pr "$BRANCH" "dsh: ${DSH_TASK_TITLE:-agent changes}" \
      --body-file "$DSH_SHIP_CACHE/dsh-pr-body.md")"
  else
    NOTE="${NOTE:+$NOTE; }WARNING: found changes but push failed"
  fi
fi

# The ship note only CLAIMS verified when the git checks truly ran;
# otherwise it says so (fail-closed honesty, never a false "verified").
if [ "${DIFF_OK:-1}" != "1" ]; then
  echo "ship note: nothing to ship — git checks could not run (UNVERIFIED)"
  echo "nothing to ship — git checks could not run (UNVERIFIED)" > "$DSH_SHIP_NOTE_FILE"
else
  echo "ship note: ${NOTE:-nothing to ship (verified: no repo-state changes, no local diff)}"
  echo "${NOTE:-nothing to ship (verified: no repo-state changes, no local diff)}" > "$DSH_SHIP_NOTE_FILE"
fi