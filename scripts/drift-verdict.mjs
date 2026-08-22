#!/usr/bin/env node
// drift-verdict.mjs — verdict extraction + review surfacing for drift-check.
//
// Why this exists (incident: drift-check run 32568700263, BLOCK verdict):
// the release gate replied BLOCK and the run went red, but the review
// explaining the verdict was written only to $RUNNER_TEMP/drift-review.md —
// never printed, wiped with the runner. drift-check's own contract says
// "BLOCK verdict: no tag, red run, review body in the log — a human decides";
// the human got one word. Two defects, both fixed here:
//
//   1. The old inline extractor (grep -oE 'TAG-WITH-FINDINGS|TAG|BLOCK' |
//      tail -1) is order-sensitive over the WHOLE reply: a legitimate
//      "TAG — nothing here warrants a BLOCK" parses as BLOCK (last substring
//      match wins) and flips the gate open-and-shut. A verdict is a LINE —
//      the reply's final word — not a substring anywhere in it.
//   2. The review body was never surfaced. It is now dumped to stderr through
//      scrub-output.mjs on EVERY verdict — BLOCK most of all, where no GitHub
//      release exists to carry it. Fail-closed: if the scrubber cannot run,
//      abort; the body is never printed raw.
//
// Usage: node drift-verdict.mjs <agent-output-file> [review-file]
//   stdout: the verdict word — TAG | TAG-WITH-FINDINGS | BLOCK — or empty
//           (empty = the agent gave no usable verdict; the workflow's gate
//           then refuses to tag).
//   stderr: the scrubbed review body, or an explicit note that none was
//           written (an agent-contract violation worth seeing in the log).
//   exit:   0 parsing completed (verdict may be empty);
//           2 bad usage / unreadable input;
//           3 scrubber failed — review body withheld, never printed raw.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? "."));
const SCRUB_TOOL = process.env.DRIFT_SCRUB_TOOL
  || path.join(SCRIPT_DIR, "scrub-output.mjs");

const [outFile, reviewFile] = process.argv.slice(2);

if (!outFile) {
  console.error("drift-verdict: usage: node drift-verdict.mjs <agent-output-file> [review-file]");
  process.exit(2);
}
if (!existsSync(outFile)) {
  // A workflow bug (file never written), not an agent hiccup — be loud.
  console.error("drift-verdict: agent output file is missing — refusing to guess a verdict");
  process.exit(2);
}

// A verdict line is a line that IS a verdict: optional markdown decoration
// (heading, bullets, emphasis, quotes), an optional "verdict:" label, the
// verdict word, optional terminal punctuation — and NOTHING else. Prose that
// merely mentions a verdict word never qualifies.
const VERDICT_LINE = /^[#>\s*_`"'(|-]*(?:verdict\s*:\s*)?(tag-with-findings|tag|block)[\s*_`*."':;,)!|]*$/i;

const verdictOfLine = line => {
  const m = VERDICT_LINE.exec(line.trim());
  return m ? m[1].toUpperCase() : null;
};

const outText = readFileSync(outFile, "utf8");

// The reply's contract is "ONLY the single verdict word" — so scan from the
// end and take the last line that is one.
let verdict = null;
for (const line of outText.split("\n").reverse()) {
  verdict = verdictOfLine(line);
  if (verdict) break;
}

let reviewText = null;
if (reviewFile && existsSync(reviewFile)) {
  reviewText = readFileSync(reviewFile, "utf8");
  // Fallback when the reply itself carried no verdict: the review's own
  // "## Verdict:" header (its documented first line) decides.
  if (!verdict) {
    const lines = reviewText.split("\n").reverse();
    for (const line of lines) {
      if (/^\s*##\s*verdict\b/i.test(line)) { verdict = verdictOfLine(line); break; }
    }
    if (!verdict) for (const line of lines) {
      verdict = verdictOfLine(line);
      if (verdict) break;
    }
  }
}

if (reviewText !== null && reviewText.trim() !== "") {
  // Fail-closed scrub, then to the log. The scrubber reads stdin → stdout.
  const scrubbed = spawnSync(process.execPath, [SCRUB_TOOL], {
    input: reviewText, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (scrubbed.error || scrubbed.status !== 0) {
    console.error("drift-verdict: scrubber failed — refusing to print the unscrubbed review body");
    process.exit(3);
  }
  process.stderr.write("::group::release review (scrubbed)\n");
  process.stderr.write(scrubbed.stdout);
  process.stderr.write("::endgroup::\n");
} else if (reviewFile) {
  process.stderr.write("drift-verdict: review body file is empty — the reviewer wrote no review\n");
} else {
  process.stderr.write("drift-verdict: no review body file — the reviewer never wrote one\n");
}

process.stdout.write(`${verdict ?? ""}\n`);
