#!/usr/bin/env node
// tests-lint.mjs — structural lint for test sources, no dependencies.
//
// Regression anchor: gates run 32933615526 (PR #27, commit 8557fb5). Its
// "no doppler CLI on the runner falls back" test constructed doppler's
// ABSENCE by restricting the child PATH to `<shimdir>:/usr/bin:/bin` —
// but the dsh lanes install the real doppler CLI in a system dir that
// this restricted PATH still traverses. command -v doppler succeeded,
// the resolver took the live-fetch branch, printed "doppler fetch
// failed" where the test demanded "no doppler cli/service token", and
// gates went red ON THE LANE ONLY: on the author's dev machine doppler
// lives in /opt/homebrew/bin, outside that PATH, so the same suite was
// green there and the landmine shipped. Nothing between "green on my
// machine" and "red on the lane" caught the pattern — this tool does.
//
// What it checks (line-based, single concern):
//   - a PATH assignment (JS `PATH:` property or shell `PATH=` inside an
//     embedded script string) whose value hard-codes literal absolute
//     path components AND does not re-include the ambient PATH
//     (`process.env.PATH` / `$PATH` / `${PATH}`) is an error: on the
//     dsh lanes the real CLIs (doppler, gh) are installed in system
//     dirs, so such a PATH constructs nothing. Absence of a
//     lane-installed CLI must be built with an explicit BIN seam
//     (e.g. DOPPLER_BIN=/nonexistent/...), as resolve-push-token.sh
//     gained in 7dd6d21; presence is constructed soundly by PREPENDING
//     a shim dir to the ambient PATH, which shadows everywhere.
//
// Scope note: only PATH-assignment lines are examined, and comment
// lines (//, *, #) are skipped — the corpus scan in
// tests/tests-lint.test.mjs keeps false positives at zero on every
// shipped test file. A multi-line value whose literal lands on the
// continuation line is out of scope for the same reason every lint
// here is line-based: catch the observed defect class, not the
// universe.

import { readFileSync } from "node:fs";

/** Ambient-PATH re-inclusion: the assignment composes with the runner's
 * PATH instead of pretending to replace it — sound on every machine. */
const AMBIENT = /process\.env\.PATH|\$\{?PATH\}?(?!\w)/;

/** A PATH assignment: `PATH:` (JS object property) or `PATH=` (shell).
 * The leading group keeps process.env.PATH reads and $PATH / ${PATH}
 * expansions from counting as assignments. */
const ASSIGNMENT = /(^|[^\w${])PATH\s*[:=]\s*(.*)$/;

/** Literal absolute path components still present after ${...}
 * interpolations are stripped (a shim dir reference like ${dir} never
 * counts — only hard-coded system paths do). */
const literalAbsPaths = (value) => {
  const stripped = value.replace(/\$\{[^}]*\}/g, "");
  const found = [];
  const re = /(?:^|[\s"'`,:;(])((?:\/[\w.-]+)+)/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) found.push(m[1]);
  return found;
};

/**
 * Lint one test-source file's text.
 * @param {string} text file contents
 * @param {string} name file name (for error messages)
 * @returns {{line: number, message: string}[]} errors, empty when clean
 */
export const lintTests = (text, name) => {
  const errors = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    // comments are dead text: JS // and block-comment bodies, shell #
    if (/^(\/\/|\*|#)/.test(trimmed)) continue;
    const m = ASSIGNMENT.exec(lines[i]);
    if (!m) continue;
    const value = m[2];
    if (AMBIENT.test(value)) continue;
    const literals = literalAbsPaths(value);
    if (!literals.length) continue;
    errors.push({
      line: i + 1,
      message: `${name}:${i + 1}: PATH hard-codes ${literals.map((l) => `'${l}'`).join(", ")} without re-including the ambient PATH — the dsh lanes install the real CLIs (doppler, gh) in system dirs, so this restriction constructs no absence and a test riding it passes on a dev machine but takes the wrong branch on a lane (gates run 32933615526). Prepend to the ambient PATH (…:\${process.env.PATH}) or construct absence with an explicit BIN seam (e.g. DOPPLER_BIN=/nonexistent/…).`,
    });
  }
  return errors;
};

/** CLI: one or more test files; exit 1 with per-line errors if any fail. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: tests-lint.mjs <test.mjs> [more.test.mjs ...]");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch (e) {
      console.error(`tests-lint: cannot read ${f}: ${e.message}`);
      bad++;
      continue;
    }
    for (const { message } of lintTests(text, f)) {
      console.error(message);
      bad++;
    }
  }
  if (bad) process.exit(1);
}
