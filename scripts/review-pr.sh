#!/usr/bin/env bash
# review-pr.sh — the adversarial review stage for the DECOUPLED worker
# (dsh-worker.sh). The decoupled twin of .github/workflows/agent-review.yml:
# same contract — the consumer repo's REVIEW.md is the rules ground truth,
# the reviewer must ground findings in the diff, and the run must END with
# a line that IS the verdict (APPROVE | REQUEST CHANGES) — but it runs
# out-of-band on the worker box instead of in a consumer Actions job.
#
# Verdict → GitHub: APPROVE ⇒ label ai-reviewed (+ remove changes-requested);
# REQUEST CHANGES ⇒ label changes-requested (+ remove ai-reviewed). Labels
# are created if missing. An absent/unparseable verdict ⇒ NO labels and a
# comment telling a human to look — the worker auto-approves nothing.
#
# Fail-closed scrubbing: every text that leaves this script (the posted
# comment) passes scrub-output.mjs; scrubber failure withholds the review.
#
# Env contract:
#   GH_TOKEN                the worker's PAT (read + comment/label on the repo)
#   DSH_SHIP_REPO           owner/repo of the PR under review
#   PR_NUM                  the PR number
#   DSH_BOT_DIR             dsh-bot toolkit checkout (contains scripts/)
#   DSH_WORKTREE            the per-task clone (review-pr.sh fetches the PR
#                           merge ref + base into it itself)
#   DSH_REVIEW_MODEL        provider/model for the reviewer (default zai/glm-5.3)
#   DSH_REVIEW_RULES_FILE   repo-relative rules path (default REVIEW.md; read
#                           from the PR's BASE ref, so the PR cannot edit its
#                           own grading contract)
#   DSH_REVIEW_OUT          where the reviewer's raw output lands
#                           (default ${RUNNER_TEMP:-/tmp}/dsh-review-output.txt)
#   DSH_RUN_ID              run identifier for the posted header
#   DSH_RUNNER_NAME         worker name for the posted header
#
# Exit: 0 review completed and posted (any verdict); 2 usage / rules
# contract missing; 3 scrubber failed; 4 no verdict (posted, unlabeled).

set -euo pipefail

DSH_SHIP_REPO="${DSH_SHIP_REPO:?review-pr: DSH_SHIP_REPO unset}"
PR_NUM="${PR_NUM:?review-pr: PR_NUM unset}"
DSH_BOT_DIR="${DSH_BOT_DIR:?review-pr: DSH_BOT_DIR unset}"
DSH_WORKTREE="${DSH_WORKTREE:?review-pr: DSH_WORKTREE unset}"
DSH_REVIEW_OUT="${DSH_REVIEW_OUT:-${RUNNER_TEMP:-/tmp}/dsh-review-output.txt}"
DSH_REVIEW_RULES_FILE="${DSH_REVIEW_RULES_FILE:-REVIEW.md}"
DSH_REVIEW_MODEL="${DSH_REVIEW_MODEL:-zai/glm-5.3}"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

command -v gh >/dev/null 2>&1 || { echo "review-pr: gh unavailable" >&2; exit 1; }

# 1. PR facts + the rules contract from the BASE (the PR must not grade
#    itself — a PR that deletes REVIEW.md must not pass because it did).
PR_JSON="$(gh pr view "$PR_NUM" --repo "$DSH_SHIP_REPO" --json baseRefName,headRefName,title 2>/dev/null || true)"
[ -n "$PR_JSON" ] || { echo "review-pr: cannot read PR #$PR_NUM in $DSH_SHIP_REPO" >&2; exit 2; }
BASE_REF="$(printf '%s' "$PR_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).baseRefName ?? "")')"
HEAD_REF="$(printf '%s' "$PR_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).headRefName ?? "")')"
PR_TITLE="$(printf '%s' "$PR_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).title ?? "")')"
[ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ] || { echo "review-pr: PR #$PR_NUM has no base/head" >&2; exit 2; }

RULES_TMP="$(mktemp)"
RULES_OK=0
# base-ref fetch via the contents API (base64) — falls back to the worktree
# (PR head) only if the base truly has no rules file.
RULES_B64="$(gh api "repos/${DSH_SHIP_REPO}/contents/${DSH_REVIEW_RULES_FILE}?ref=${BASE_REF}" --jq .content 2>/dev/null || true)"
if [ -n "$RULES_B64" ]; then
  printf '%s' "$RULES_B64" | base64 -d > "$RULES_TMP" 2>/dev/null && RULES_OK=1
fi
if [ "$RULES_OK" != "1" ] && [ -f "$DSH_WORKTREE/$DSH_REVIEW_RULES_FILE" ]; then
  cp "$DSH_WORKTREE/$DSH_REVIEW_RULES_FILE" "$RULES_TMP" && RULES_OK=1
fi
if [ "$RULES_OK" != "1" ]; then
  rm -f "$RULES_TMP"
  echo "review-pr: no $DSH_REVIEW_RULES_FILE at base $BASE_REF nor in the worktree — refusing to review without the rules contract" >&2
  exit 2
fi

# 2. The diff (merge ref vs base) into the worktree.
cd "$DSH_WORKTREE" || { echo "review-pr: cannot cd to $DSH_WORKTREE" >&2; exit 2; }
# The initial clone + fetch in the worker used env-based git config (token
# in the environment, never on argv — argv is ps-readable). The push
# credential resolve-push-token.sh wrote lives in .git/config, so these
# extra fetches can ride the same env seam and are harmless when the token
# is absent (public repos).
# BASIC auth (base64 x-access-token:TOKEN): the API-scheme header 401s on
# git http (proven live on seed-dshbot). Env-borne, never argv; the stale
# box credential helper is reset.
gh_fetch() { # <refspec:local-ref>
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="$(printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")" \
    git -c credential.helper= fetch -q --depth 1 origin "$1"
}
fetch_merge() { gh_fetch "refs/pull/${PR_NUM}/merge:refs/remotes/origin/pr-merge"; }
fetch_base()   { gh_fetch "refs/heads/${BASE_REF}:refs/remotes/origin/base"; }
fetch_merge 2>/dev/null \
  || { echo "review-pr: cannot fetch PR #$PR_NUM merge ref" >&2; rm -f "$RULES_TMP"; exit 2; }
fetch_base 2>/dev/null || true
DIFF="$(git diff origin/base...origin/pr-merge 2>/dev/null || git diff "$(git merge-base origin/base origin/pr-merge 2>/dev/null || echo origin/base)" origin/pr-merge 2>/dev/null || echo "(diff unavailable)")"
DIFF_STAT="$(git diff --stat origin/base...origin/pr-merge 2>/dev/null | tail -n 30 || true)"
DIFF_CAP=6000
DIFF_LINES="$(printf '%s' "$DIFF" | wc -l | tr -d ' ')"
[ "${DIFF_LINES:-0}" -gt "$DIFF_CAP" ] && DIFF="$(printf '%s' "$DIFF" | head -n "$DIFF_CAP")"
GATES="$(gh pr checks "$PR_NUM" --repo "$DSH_SHIP_REPO" 2>/dev/null | head -n 15 || echo "(checks unavailable)")"

# 3. Compose the review task (env-borne, never raw interpolation).
TASK_FILE="$(mktemp)"
cat > "$TASK_FILE" <<EOF
You are the adversarial reviewer for PR #$PR_NUM in $DSH_SHIP_REPO.

The rules contract (REVIEW.md at the BASE ref — the PR under review cannot
edit it):
$(cat "$RULES_TMP")

PR: #$PR_NUM "$PR_TITLE" ($BASE_REF ← $HEAD_REF)

Diff (base...merge, truncated to $DIFF_CAP lines):
$DIFF

Diff stat:
$DIFF_STAT

Gates status on the PR:
$GATES

Review for correctness ("no swallowed exits", fail-closed scrubbing, tests
that actually construct what they claim), workflow discipline, and honesty
(overstatement is blocking, same as a bug). Fix or verify anything you
claim; an unreproducible claim is a finding. Do NOT push commits, do NOT
open PRs, do NOT comment on the PR — your final answer is posted for you.

CONTRACT (violating it discards your review): your final answer MUST END
WITH, as its very last line, exactly one of these two lines — nothing
after it, no prose, no sign-off:
## Verdict: APPROVE
## Verdict: REQUEST CHANGES
A report without that final line is a contract violation: the harness
parses no verdict, sets no labels, and forces human review — your entire
review then carries no machine weight. "## Required to merge" sections or
blocking findings in prose do NOT count; ONLY the literal Verdict line
does.
EOF

# 4. Run the reviewer (off the same driver; the worktree is at the PR merge
#    ref — the ONLY ref involved, so the reader cannot drift to another).
rc=0
DSH_MODEL="$DSH_REVIEW_MODEL" DSH_SUBAGENT_MODEL="" REPLY_TARGET="" \
  bash "$DSH_BOT_DIR/scripts/run-dsh-agent.sh" "$(cat "$TASK_FILE")" \
  | node "$DSH_BOT_DIR/scripts/scrub-output.mjs" > "$DSH_REVIEW_OUT" || rc=$?
rm -f "$TASK_FILE" "$RULES_TMP"
if [ "$rc" -ne 0 ]; then
  echo "review-pr: reviewer driver exited $rc — review incomplete" >&2
fi

# 5. Verdict — line-strict, fail-closed on absence.
VERDICT="$(node "$DSH_BOT_DIR/scripts/review-verdict.mjs" "$DSH_REVIEW_OUT" 2>/dev/null || true)"

# 6. Post: scrubbed body as a PR comment, labels per verdict. Fail-closed:
#    the review comment is scrubbed output — a scrubber failure means the
#    review is NOT posted and the script exits 3 (the header's exit-3
#    contract, which the review round on PR #45 found to be dead code: the
#    placeholder text was posted instead of failing).
POST_BODY="$(mktemp)"
# the driver's meta (this review's own run) supplies the harness version
DSH_META_FILE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}/dsh-run-meta.env"
DSH_RUN_DSH_VERSION=""
[ -f "$DSH_META_FILE" ] && . "$DSH_META_FILE"
{
  echo "**dsh review (worker)** — run: ${DSH_RUN_ID:-_} — model: ${DSH_REVIEW_MODEL} — harness: dsh-${DSH_RUN_DSH_VERSION:-?}"
  echo
} > "$POST_BODY"
if ! node "$DSH_BOT_DIR/scripts/scrub-output.mjs" < "$DSH_REVIEW_OUT" >> "$POST_BODY" 2>/dev/null; then
  echo "review-pr: scrubber failed — review NOT posted (fail-closed, exit 3)" >&2
  rm -f "$POST_BODY" "$RULES_TMP"
  exit 3
fi
gh pr comment "$PR_NUM" --repo "$DSH_SHIP_REPO" --body-file "$POST_BODY" 2>/dev/null \
  || echo "review-pr: comment post failed (check PAT scope on $DSH_SHIP_REPO)" >&2
rm -f "$POST_BODY"

case "$VERDICT" in
  APPROVE)
    gh label create ai-reviewed --repo "$DSH_SHIP_REPO" --force >/dev/null 2>&1 || true
    gh pr edit "$PR_NUM" --repo "$DSH_SHIP_REPO" --add-label ai-reviewed --remove-label changes-requested >/dev/null 2>&1 || true
    echo "review-pr: verdict APPROVE — labeled ai-reviewed";;
  REQUEST\ CHANGES)
    gh label create changes-requested --repo "$DSH_SHIP_REPO" --force >/dev/null 2>&1 || true
    gh pr edit "$PR_NUM" --repo "$DSH_SHIP_REPO" --add-label changes-requested --remove-label ai-reviewed >/dev/null 2>&1 || true
    echo "review-pr: verdict REQUEST CHANGES — labeled changes-requested";;
  *)
    echo "review-pr: NO VERDICT ($VERDICT) — no labels applied, human review required" >&2
    exit 4;;
esac

exit 0