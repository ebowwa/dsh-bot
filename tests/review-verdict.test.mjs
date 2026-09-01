// review-verdict.test.mjs — tests for scripts/review-verdict.mjs.
//
// The worker's review must NEVER auto-approve: labels are set only from a
// line-strict verdict parse. These tests pin the parse (last line that IS
// a verdict wins; prose mentioning a verdict word never qualifies; absent
// verdict = empty output) and the fail-closed scrub path (a scrubber
// failure withholds the body, exit 3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "review-verdict.mjs");

/** Run the tool over a reply; return the spawn result. */
const run = (reply, env = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-verdict-test-"));
  try {
    const outFile = path.join(dir, "review-out.txt");
    writeFileSync(outFile, reply ?? "");
    return spawnSync(process.execPath, [TOOL, outFile], {
      encoding: "utf8", env: { ...process.env, ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const verdictOf = (reply, env) => run(reply, env).stdout.trim();

test("approve verdict as its own final line", () => {
  assert.equal(verdictOf("Looks good. Nothing blocking.\n## Verdict: APPROVE\n"), "APPROVE");
});

test("request-changes verdict, decorated line", () => {
  assert.equal(verdictOf("One blocking finding.\n**Verdict:** REQUEST CHANGES"), "REQUEST CHANGES");
});

test("APPROVED normalizes to APPROVE; CHANGES REQUESTED normalizes to REQUEST CHANGES", () => {
  assert.equal(verdictOf("ok\nVerdict: APPROVED"), "APPROVE");
  assert.equal(verdictOf("ok\nVerdict: CHANGES REQUESTED"), "REQUEST CHANGES");
});

test("verdict word inside prose is NOT a verdict (substring trap)", () => {
  assert.equal(
    verdictOf("No blocking defects, so APPROVE.\nI verified every claim.\n"),
    "",
  );
});

test("last verdict line wins, not the first (drift-verdict lesson)", () => {
  assert.equal(verdictOf("## Verdict: APPROVE\n...\n## Verdict: REQUEST CHANGES\n"), "REQUEST CHANGES");
});

test("no verdict line → empty output (caller must refuse to label)", () => {
  assert.equal(verdictOf("Summary: five findings, no verdict word at all.\n"), "");
});

test("empty reply → empty output", () => {
  assert.equal(verdictOf(""), "");
});

test("scrubber failure withholds the body and exits 3 (fail-closed)", () => {
  const res = run("## Verdict: APPROVE\nsecret content", { REVIEW_SCRUB_TOOL: "/nonexistent/scrubber" });
  assert.equal(res.status, 3);
  assert.match(res.stderr, /scrubber failed/);
  assert.equal(res.stdout.trim(), "");
});

test("returned body on stderr is the SCRUBBED reply, never raw", () => {
  const res = run("## Verdict: REQUEST CHANGES\nkey: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n");
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "REQUEST CHANGES");
  assert.match(res.stderr, /\[redacted:token\]/);
  assert.ok(!res.stderr.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"));
});

test("missing input file → exit 2, refuses to guess", () => {
  const res = spawnSync(process.execPath, [TOOL, "/nonexistent/output.txt"], {
    encoding: "utf8", env: process.env,
  });
  assert.equal(res.status, 2);
});