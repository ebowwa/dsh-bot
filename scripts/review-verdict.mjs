#!/usr/bin/env node
// review-verdict.mjs — line-strict verdict extraction for the worker's
// review stage (scripts/review-pr.sh), the decoupled twin of
// drift-verdict.mjs. Same contract, different vocabulary:
//
// A verdict is A LINE that IS a verdict — the review's final word — never
// a substring anywhere in it ("no blocking defects, so APPROVE" inside a
// findings paragraph must not parse as a verdict). The reviewer is
// instructed to END with a Verdict line; this parser takes the LAST line
// that is one, mirroring drift-verdict.mjs exactly (the drift extractor
// flipped BLOCK<->TAG on exactly this class — run 32568700263).
//
// Vocabulary (identical to agent-review.yml's contract):
//   APPROVE | REQUEST CHANGES
// (APPROVED and CHANGES REQUESTED normalize onto those two; anything else
// is no verdict — empty output, and the caller refuses to vote.)
//
// Usage: node review-verdict.mjs <agent-output-file>
//   stdout: the verdict word — APPROVE | REQUEST CHANGES — or empty
//           (empty = the reviewer gave no usable verdict; the caller must
//            refuse to label rather than guess).
//   stderr: the scrubbed review body (the comment the caller posts), or an
//           explicit note that none was written (fail-closed: the scrubber
//           is required; a scrubber failure exits 3 and withholds the body
//           — never printed raw).
//   exit:   0 parsing completed (verdict may be empty);
//           2 bad usage / unreadable input;
//           3 scrubber failed — review body withheld, never printed raw.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? "."));
const SCRUB_TOOL = process.env.REVIEW_SCRUB_TOOL
  || path.join(SCRIPT_DIR, "scrub-output.mjs");

const [outFile] = process.argv.slice(2);

if (!outFile) {
  console.error("review-verdict: usage: node review-verdict.mjs <agent-output-file>");
  process.exit(2);
}
if (!existsSync(outFile)) {
  // A pipeline bug (file never written), not a reviewer hiccup — be loud.
  console.error("review-verdict: agent output file is missing — refusing to guess a verdict");
  process.exit(2);
}

// Verdict = a line that after stripping markdown decoration is, in order:
// an optional "verdict:" label, the verdict word, optional terminal
// punctuation — and NOTHING else. Prose that merely mentions a verdict
// word never qualifies ("No blocking defects, so APPROVE" strips to
// something that cannot match the anchored shape).
const DECOR = /[*_`>#"']/g;
const VERDICT_LINE = /^\s*(?:verdict\s*:\s*)?(approve|approved|request\s+changes|changes\s+requested)[.,;:!\s]*$/i;

const verdictOfLine = line => {
  const stripped = line.trim().replace(DECOR, "");
  const m = VERDICT_LINE.exec(stripped);
  if (!m) return null;
  switch (m[1].toLowerCase()) {
    case "approve":
    case "approved":
      return "APPROVE";
    case "request changes":
    case "changes requested":
      return "REQUEST CHANGES";
    default:
      return null;
  }
};

const outText = readFileSync(outFile, "utf8");

// The contract is "the reply's final word" — scan from the end, last line
// that is ONE verdict wins.
let verdict = null;
for (const line of outText.split("\n").reverse()) {
  verdict = verdictOfLine(line);
  if (verdict) break;
}

if (outText.trim() !== "") {
  // Fail-closed scrub, then to stderr — the caller feeds this to the
  // comment it posts. The scrubber reads stdin → stdout.
  const scrubbed = spawnSync(process.execPath, [SCRUB_TOOL], {
    input: outText, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (scrubbed.error || scrubbed.status !== 0) {
    console.error("review-verdict: scrubber failed — refusing to print the unscrubbed review body");
    process.exit(3);
  }
  if (scrubbed.stdout.trim() !== "") {
    process.stderr.write("::group::PR review (scrubbed)\n");
    process.stderr.write(scrubbed.stdout);
    process.stderr.write("::endgroup::\n");
  } else {
    process.stderr.write("review-verdict: review body came back empty after scrubbing\n");
  }
} else {
  process.stderr.write("review-verdict: agent output file is empty — the reviewer wrote nothing\n");
}

process.stdout.write(`${verdict ?? ""}\n`);