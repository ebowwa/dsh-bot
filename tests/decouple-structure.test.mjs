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

test("decoupled-mode docs exist and describe the queue + trust model", () => {
  assert.ok(existsSync(path.join(ROOT, "docs", "decoupled-worker.md")));
  const doc = read("docs/decoupled-worker.md");
  assert.match(doc, /dsh\/queued/);
  assert.match(doc, /DSH_WORKER_REPOS/);
  assert.match(doc, /never auto-approves/);
});