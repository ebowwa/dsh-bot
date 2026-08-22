// drift-verdict.test.mjs — tests for scripts/drift-verdict.mjs.
//
// Regression anchor: drift-check run 32568700263 (BLOCK verdict). The review
// explaining the block was written only to $RUNNER_TEMP/drift-review.md and
// never surfaced — the run log carried a single word, and the tagging step's
// "see the review above" pointed at nothing. These tests fail without the
// fix: revert drift-verdict.mjs (or the drift-check.yml wiring at the
// bottom) and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "drift-verdict.mjs");

/** Run the tool over a reply (and optional review body); return the spawn result. */
const run = (reply, review, env = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "drift-verdict-test-"));
  try {
    const outFile = path.join(dir, "drift-out.txt");
    writeFileSync(outFile, reply ?? "");
    const args = [TOOL, outFile];
    if (review !== undefined) {
      const reviewFile = path.join(dir, "drift-review.md");
      writeFileSync(reviewFile, review);
      args.push(reviewFile);
    }
    return spawnSync(process.execPath, args, {
      encoding: "utf8", env: { ...process.env, ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const verdictOf = (reply, review, env) => run(reply, review, env).stdout.trim();

const REVIEW = `## Verdict: TAG
## What changed
- scripts/run-dsh-agent.sh — per-job DSH_HOME
## Consumer impact
- none
## Findings
1. (low) comment typo
`;

test("clean one-word replies are extracted", () => {
  assert.equal(verdictOf("TAG\n"), "TAG");
  assert.equal(verdictOf("BLOCK\n"), "BLOCK");
  assert.equal(verdictOf("TAG-WITH-FINDINGS\n"), "TAG-WITH-FINDINGS");
});

test("prose mentioning another verdict word cannot flip the gate", () => {
  // A perfectly reasonable approval that names the alternative: the old
  // inline extractor (last substring match wins) read this as BLOCK.
  const reply = "Reviewed the full diff. TAG — nothing here warrants a BLOCK.\n";
  // Under the strict parser, prose NEVER qualifies as a verdict line: no
  // bare verdict word -> empty verdict -> the gate refuses to tag
  // (fail-closed; the old extractor could mis-parse the OTHER way and
  // auto-tag on a "BLOCK ... TAG" reply). The review's Verdict header
  // then recovers the intent:
  assert.equal(verdictOf(reply), "");
  assert.equal(verdictOf(reply, REVIEW), "TAG");
  // Mirror image: a block dressed as prose must not silently become a TAG.
  const blockReview = REVIEW.replace("## Verdict: TAG", "## Verdict: BLOCK");
  const reply2 = "A consumer-supplied DSH_HOME would be rm -rf'd at exit — BLOCK, not TAG.\n";
  assert.equal(verdictOf(reply2), "");
  assert.equal(verdictOf(reply2, blockReview), "BLOCK");
});

test("the pre-fix extractor mis-parsed the multi-word reply (regression proof)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "drift-verdict-old-"));
  try {
    const outFile = path.join(dir, "drift-out.txt");
    writeFileSync(outFile, "Reviewed the full diff. TAG — nothing here warrants a BLOCK.\n");
    const old = spawnSync("bash", ["-c",
      `grep -oE 'TAG-WITH-FINDINGS|TAG|BLOCK' "$1" | tail -1`, "x", outFile,
    ], { encoding: "utf8" });
    // Documents WHY the inline grep was replaced: it flips the verdict.
    assert.equal(old.stdout.trim(), "BLOCK");
    assert.notEqual(verdictOf("Reviewed the full diff. TAG — nothing here warrants a BLOCK.\n"),
      old.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lightly formatted verdict lines still parse", () => {
  assert.equal(verdictOf("**BLOCK**\n"), "BLOCK");
  assert.equal(verdictOf("Verdict: TAG.\n"), "TAG");
  assert.equal(verdictOf("## Verdict: TAG-WITH-FINDINGS\n"), "TAG-WITH-FINDINGS");
  assert.equal(verdictOf("- `TAG`\n"), "TAG");
});

test("the reply's LAST bare verdict line wins; prose alone yields no verdict", () => {
  assert.equal(verdictOf("TAG\n\nBLOCK\n"), "BLOCK");
  // "On reflection: BLOCK" is prose, not a verdict line — a bare TAG above
  // it stands. Only a line that IS a verdict (plus formatting/label) counts.
  assert.equal(verdictOf("TAG\n\nOn reflection: BLOCK\n"), "TAG");
  assert.equal(verdictOf("Reviewed 3 files; all safe.\n"), "");
  assert.equal(verdictOf(""), "");
});

test("with no verdict in the reply, the review's Verdict header decides", () => {
  assert.equal(verdictOf("Done.\n", REVIEW), "TAG");
});

test("the review body is surfaced on stderr, scrubbed — the run-32568700263 defect", () => {
  const body = REVIEW.replace("1. (low) comment typo",
    "1. (critical) a pasted token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA appears here");
  const r = run("BLOCK\n", body);
  assert.equal(r.stdout.trim(), "BLOCK");
  assert.match(r.stderr, /## Verdict: TAG/);
  assert.match(r.stderr, /## Consumer impact/);
  // the planted credential never reaches the log raw
  assert.ok(!r.stderr.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
  assert.match(r.stderr, /\[redacted:token\]/);
});

test("a missing review body is reported explicitly, not silently dropped", () => {
  const r = run("BLOCK\n");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "BLOCK");
  assert.match(r.stderr, /no review body file — the reviewer never wrote one/);
  const rEmpty = run("BLOCK\n", "   \n");
  assert.match(rEmpty.stderr, /wrote no review/);
});

test("scrubber failure is fail-closed: no body, non-zero exit", () => {
  const r = run("BLOCK\n", REVIEW, { DRIFT_SCRUB_TOOL: "/nonexistent/scrub.mjs" });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), "");
  assert.ok(!r.stderr.includes("## Consumer impact"));
  assert.match(r.stderr, /scrubber failed/);
});

test("missing agent output file is a loud usage error", () => {
  const r = spawnSync(process.execPath, [TOOL, "/nonexistent/drift-out.txt"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("drift-check.yml wires the parser in (revert guard)", () => {
  const wf = readFileSync(path.join(ROOT, ".github", "workflows", "drift-check.yml"), "utf8");
  assert.ok(wf.includes("scripts/drift-verdict.mjs"),
    "drift-check must extract verdicts via scripts/drift-verdict.mjs");
  assert.ok(!wf.includes("grep -oE 'TAG-WITH-FINDINGS|TAG|BLOCK'"),
    "the order-sensitive inline grep extractor must not come back");
  // release notes are a public egress: the review body must be scrubbed
  // before it is published (review finding #1 on the incident PR)
  assert.ok(!wf.includes('--notes-file "$RUNNER_TEMP/drift-review.md"'),
    "raw (unscrubbed) review body must not be published as release notes");
  assert.ok(wf.includes("drift-review.scrubbed.md"),
    "release notes must come from the scrubbed copy of the review");
});

test("gates.yml runs this suite (revert guard)", () => {
  const gates = readFileSync(path.join(ROOT, ".github", "workflows", "gates.yml"), "utf8");
  assert.match(gates, /node --test/);
});
