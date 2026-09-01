// decouple-structure.test.mjs — structural pins for the decoupled mode:
// the pieces that MUST stay wired together, asserted as file contents so a
// future edit that silently disconnects a seam goes red here (the same
// style as the drift moving-tag regression test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(path.join(ROOT, p), "utf8");

test("legacy comment workflow calls the shared shipper + reply scripts (not inline copies)", () => {
  const wf = read(".github/workflows/agent-comment.yml");
  assert.match(wf, /ship-changes\.sh/);
  assert.match(wf, /post-reply\.sh/);
  // the old inline shipper/reply bodies are gone
  assert.ok(!wf.includes("dsh/auto-r${GITHUB_RUN_ID}"));
});

test("thin trigger: github-hosted, acks with the marker, enqueues with the label", () => {
  const thin = read(".github/workflows/agent-comment-thin.yml");
  assert.match(thin, /runs-on: ubuntu-latest/);
  assert.match(thin, /dsh:ack/);
  assert.match(thin, /dsh\/queued/);
  assert.match(thin, /labels\[\]/);
});

test("thin consumer shell calls the thin trigger", () => {
  const shell = read("examples/dsh-agent-thin.yml");
  assert.match(shell, /agent-comment-thin\.yml/);
});

test("worker never dispatches a review workflow (review is inline) and reuses every stage", () => {
  const w = read("scripts/dsh-worker.sh");
  assert.match(w, /REVIEW_WORKFLOW=""[\s\S]*DSH_TASK_TITLE/); // shipper call disables dispatch
  for (const stage of ["run-dsh-agent.sh", "ship-changes.sh", "post-reply.sh", "review-pr.sh"]) {
    assert.match(w, new RegExp(stage, "i"));
  }
  // trust is re-derived from the comments API, never from the label alone
  assert.match(w, /author_association/);
});

test("worker review reads the rules from the PR BASE (a PR cannot grade itself)", () => {
  const rp = read("scripts/review-pr.sh");
  assert.match(rp, /contents\/\$\{DSH_REVIEW_RULES_FILE\}\?ref=\$\{BASE_REF\}/);
  assert.match(rp, /refusing to review without the rules contract/);
});

// Regression pins for the PR #45 review round — every blocking finding is
// pinned structurally so a reintroduction goes red here.
test("PR45 F1+F2: worker passes DSH_SHIP_REPO (required env guard) to reply AND review", () => {
  const w = read("scripts/dsh-worker.sh");
  assert.match(w, /DSH_SHIP_REPO="\$repo" DSH_SHIP_CACHE="\$rundir"[\s\S]*?post-reply\.sh/);
  assert.match(w, /DSH_SHIP_REPO="\$repo" DSH_REVIEW_OUT[\s\S]*?review-pr\.sh/);
});

test("PR45 F3: fetch_context writes to its outdir argument, not \$1 (the repo)", () => {
  const w = read("scripts/dsh-worker.sh");
  assert.match(w, /local repo="\$1" num="\$2" outdir="\$3"/);
  assert.match(w, /\$outdir\/thread-context\.txt/);
  assert.ok(!/\$1\/thread-context\.txt/.test(w), "the redirect must never land on \$1 (the repo name) again");
});

test("PR50 r2 F3: the ctx directory is CREATED before fetch_context writes into it", () => {
  const w = read("scripts/dsh-worker.sh");
  // The round-2 finding: the redirect target existed but the dir never was
  // created, so the write still failed under || true. The mkdir must
  // include the ctx dir and precede the fetch_context call in the file.
  const mkdirIdx = w.indexOf('mkdir -p "$rundir/tmp" "$rundir/ctx" "$work"');
  const fetchIdx = w.indexOf('fetch_context "$repo" "$num" "$rundir/ctx"');
  assert.ok(mkdirIdx !== -1, "ctx dir must be created in process_item");
  assert.ok(fetchIdx !== -1, "fetch_context must target the run dir");
  assert.ok(mkdirIdx < fetchIdx, "mkdir must run BEFORE fetch_context");
});

test("PR50 r2 F7: abort_item is pinned — it posts a thread note before releasing the label", () => {
  const w = read("scripts/dsh-worker.sh");
  assert.match(w, /abort_item\(\) \{/);
  assert.match(w, /gh api "repos\/\$\{repo\}\/issues\/\$\{num\}\/comments"/); // posts on the thread
  assert.match(w, /abort_item "\$repo" "\$num" "\$rundir" "checkout of the target ref"/);
  assert.match(w, /abort_item "\$repo" "\$num" "\$rundir" "push-credential write/);
});

test("PR50 r2: worker shipper does NOT set a custom note filename (the reply must find the note)", () => {
  const w = read("scripts/dsh-worker.sh");
  // post-reply.sh reads $DSH_SHIP_CACHE/dsh-ship-note.txt; the worker's
  // shipper call must use that default — a custom DSH_SHIP_NOTE_FILE
  // silently dropped the Shipped note from the worker's reply. No
  // ASSIGNMENT may exist (the explanatory comment may reference the name).
  assert.ok(!/DSH_SHIP_NOTE_FILE="/.test(w), "no custom note filename assignment (reply reads the default path)");
});

test("PR50 r2: a real shipping NOTE always beats the UNVERIFIED branch (never overwritten)", () => {
  const s = read("scripts/ship-changes.sh");
  assert.match(s, /if \[ -n "\$NOTE" \]/);
  // lastIndexOf UNVERIFIED = the real branch's message; the real-NOTE
  // check must come before it in the file (comments may mention the word
  // earlier — that is why lastIndexOf).
  const noteIdx = s.indexOf('[ -n "$NOTE" ]');
  const unverifiedIdx = s.lastIndexOf("UNVERIFIED");
  assert.ok(noteIdx !== -1 && noteIdx < unverifiedIdx, "the real-note branch must be evaluated before UNVERIFIED");
});

test("PR45 F4: driver has a typed DOPPLER_SERVICE_TOKEN guard (required env)", () => {
  const drv = read("scripts/run-dsh-agent.sh");
  assert.match(drv, /DOPPLER_SERVICE_TOKEN unset/);
  const ex = read("config/dsh-worker.env.example");
  assert.match(ex, /DOPPLER_SERVICE_TOKEN=.*required/);
});

test("PR45 F5: shipper claims 'verified' only when the git checks ran", () => {
  const s = read("scripts/ship-changes.sh");
  assert.match(s, /DIFF_OK=1/);
  assert.match(s, /UNVERIFIED/);
});

test("PR45 F6: trigger matcher equals gate+worker (contains @dsh-agent)", () => {
  const thin = read(".github/workflows/agent-comment-thin.yml");
  assert.match(thin, /\*@dsh-agent\*\)/);
});

test("PR45 F8: review-pr scrub failure is a real fail-closed exit 3 (no dead contract)", () => {
  const rp = read("scripts/review-pr.sh");
  assert.match(rp, /exit 3/);
  assert.match(rp, /scrubber failed — review NOT posted/);
});

test("decoupled-mode docs exist and describe the queue + trust model", () => {
  assert.ok(existsSync(path.join(ROOT, "docs", "decoupled-worker.md")));
  const doc = read("docs/decoupled-worker.md");
  assert.match(doc, /dsh\/queued/);
  assert.match(doc, /DSH_WORKER_REPOS/);
  assert.match(doc, /never auto-approves/);
});
test("review queue: worker claims dsh/review items and runs review-pr.sh on them", () => {
  const w = read("scripts/dsh-worker.sh");
  assert.match(w, /REVIEW_LABEL="\$\{DSH_WORKER_REVIEW_LABEL:-dsh\/review\}"/);
  assert.match(w, /review_item\(\) \{/);
  // the sweep polls the review label and routes PRs to review_item
  const pollIdx = w.indexOf("labels=${REVIEW_LABEL}&per_page=100");
  assert.ok(pollIdx !== -1, "sweep must poll the review label");
  assert.match(w, /review_item "\$repo" "\$num"/);
  // claim semantics identical to agent tasks: DELETE the label to claim
  assert.match(w, /labels\/\$\(label_enc "\$REVIEW_LABEL"\)/);
});

test("review queue: dsh-review.yml is THIN — enqueues, never holds a runner", () => {
  const shell = read(".github/workflows/dsh-review.yml");
  assert.ok(!shell.includes("agent-review.yml@"), "the runner-holding legacy review must not be dispatched by this repo's own shell");
  assert.match(shell, /agent-review-thin\.yml/);
  const thin = read(".github/workflows/agent-review-thin.yml");
  assert.match(thin, /runs-on: ubuntu-latest/);
  assert.match(thin, /dsh\/review/);
  assert.match(thin, /labels\[\]/);
});

test("review queue: consumer example enqueues the decoupled review", () => {
  const ex = read("examples/dsh-review.yml");
  assert.match(ex, /agent-review-thin\.yml/);
  assert.ok(!ex.includes("agent-review.yml@"), "example must not point at the runner-holding review");
});

test("drift v1.46.0 findings: pin, failure notes, review cap — all fixed", () => {
  // F1: dsh-review.yml must not pin @main (self-drift); @v1 is the
  // documented moving major (drift-check advances it on TAG verdicts).
  const shell = read(".github/workflows/dsh-review.yml");
  assert.ok(!shell.includes("agent-review-thin.yml@main"), "unpinned @main ref is self-drift");
  assert.match(shell, /agent-review-thin\.yml@v1\b/);

  const w = read("scripts/dsh-worker.sh");
  // F2: a mid-review failure (timeout/crash) posts a thread note; the
  // label is NOT re-added (systemic failures must not loop the worker).
  assert.match(w, /worker review of this PR failed before producing a verdict/);
  const failNoteIdx = w.indexOf("worker review of this PR failed");
  const requeueAfterFail = w.slice(failNoteIdx, failNoteIdx + 900).includes('f labels[]="$REVIEW_LABEL"');
  assert.ok(!requeueAfterFail, "the mid-review failure path must NOT re-queue the label");
  // ...and NEITHER failure path auto-requeues: an unconditional re-queue
  // on a persistently failing clone posts one comment per sweep forever
  // (self-caught during this PR's own review) — humans re-fire /review.
  const cloneFailIdx = w.indexOf("could not clone the repo for this review");
  assert.ok(cloneFailIdx !== -1, "clone failure posts a thread note");
  assert.ok(!w.slice(cloneFailIdx, cloneFailIdx + 900).includes('f labels[]="$REVIEW_LABEL"'),
    "the clone-failure path must NOT re-queue (comment-spam loop)");
  // F3 + INFO 4: the header documents the review label + a separate
  // review cap with the legacy 45m default.
  assert.match(w, /DSH_WORKER_REVIEW_LABEL\s+review-queue label/);
  assert.match(w, /\$\{DSH_WORKER_REVIEW_TIMEOUT_MIN:-45\}m/);
});

test("live fixes (seed-dshbot): Basic-auth git header, $(cat) note bodies, bracket pgrep", () => {
  const w = read("scripts/dsh-worker.sh");
  // git auth is BASIC (base64 x-access-token:...) — the API-scheme header
  // 401'd on git http with a VALID token (live: API green, clone 401)
  assert.match(w, /AUTHORIZATION: basic/);
  assert.ok(!/Authorization: token \$\{GH_TOKEN\}/.test(w), "API-scheme header must not ride git http");
  // note bodies post via $(cat …) — the @file form posted a literal path
  // string live on PR #44
  assert.ok(!/-f body=@/.test(w), "@file bodies must not be used (did not expand on the box gh)");
  assert.match(w, /-f body="\$\(cat \$rundir\//);
  const inst = read("scripts/install-worker.sh");
  assert.match(inst, /'\[d\]sh-worker\.sh --once'/);
  // upgrade path: a previously installed self-matching line gets REPLACED
  assert.match(inst, /replacing the pre-fix \(self-matching\) keepalive/);
});
