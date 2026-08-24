// workflow-lint.test.mjs — tests for scripts/workflow-lint.mjs.
//
// Regression anchor: agent-dispatch run 32705244305. The flight recorder
// step landed at 4-space indent inside a 6-space steps: list — a sequence
// item dedenting onto the mapping level. The workflow file stopped
// parsing (zero jobs, "workflow file issue"), every workflow_call
// dispatch 422'd, and PR #10 re-indented it by hand. The gates.yml
// "Workflow YAML parses" step only rejected tabs, so the broken file
// passed that check green (the drift check was red; gates alone waved it
// through). These tests fail without the fix: revert the linter, the
// gates wiring, or re-break the indentation and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintWorkflow } from "../scripts/workflow-lint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "workflow-lint.mjs");
const WF_DIR = path.join(ROOT, ".github", "workflows");

const runTool = (args) =>
  spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

const withFile = (text, fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), "workflow-lint-test-"));
  try {
    const f = path.join(dir, "wf.yml");
    writeFileSync(f, text);
    return fn(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// The d8e6a4c defect, distilled: steps items at 6, upload step at 4.
const PREFIX = `name: agent-dispatch
on:
  workflow_call:
jobs:
  dsh-agent:
    runs-on: [self-hosted, dsh]
    steps:
      - name: Run agent
        run: |
          echo go
    # FLIGHT RECORDER
`;
const BROKEN = PREFIX + `    - name: Upload session transcript (flight recorder)
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: dsh-session-\${{ github.run_id }}
`;

// The PR #10 fix: the whole step at the column its sequence actually uses.
const FIXED = PREFIX + `      - name: Upload session transcript (flight recorder)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: dsh-session-\${{ github.run_id }}
`;

test("the run-32705244305 defect is rejected: step item dedented onto the mapping level", () => {
  const errors = lintWorkflow(BROKEN, "agent-dispatch.yml");
  assert.ok(errors.length > 0, "the broken indentation must not lint clean");
  assert.match(errors[0].message, /dedents onto a mapping level/);
  assert.equal(errors[0].line, 12); // the '- name: Upload' line itself
});

test("the fixed six-space indentation lints clean", () => {
  assert.deepEqual(lintWorkflow(FIXED, "agent-dispatch.yml"), []);
});

test("CLI exits 1 on the broken file, 0 on the fixed one", () => {
  withFile(BROKEN, (f) => {
    const r = runTool([f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dedents onto a mapping level/);
  });
  withFile(FIXED, (f) => {
    const r = runTool([f]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  });
});

test("the legal same-column sequence style is not a false positive", () => {
  // 'steps:' then items at the key's own column is valid YAML — the linter
  // must allow it (and the key that resumes after such a sequence).
  const ok = `name: x
on:
  push:
jobs:
  j:
    runs-on: [self-hosted, dsh]
    steps:
    - name: a
      run: echo hi
    - name: b
      run: echo bye
  k:
    runs-on: [self-hosted, dsh]
`;
  assert.deepEqual(lintWorkflow(ok), []);
});

test("block scalars (run: |, runs-on: >-) are skipped, not parsed", () => {
  const ok = `name: x
jobs:
  j:
    runs-on: >-
      \${{ matrix.os }}
    steps:
      - name: a
        run: |
          # not a comment structure, and this is not a step:
          - fake: yaml at column 10
          echo done
      - name: b
        run: echo bye
`;
  assert.deepEqual(lintWorkflow(ok), []);
});

test("a line landing BETWEEN item and content columns is rejected (review finding on PR #11)", () => {
  // One column too deep (7, between item col 6 and content col 8) is
  // invalid block YAML with the same parse-failure blast radius — the
  // first lint revision silently accepted it as a fresh scope.
  const itemBetween = `name: x
jobs:
  j:
    steps:
      - name: a
        run: echo hi
       - name: b
`;
  const errorsA = lintWorkflow(itemBetween, "wf");
  assert.ok(errorsA.length > 0, "a between-columns sequence item must not lint clean");
  assert.match(errorsA[0].message, /matches no open scope/);
  assert.equal(errorsA[0].line, 7);

  const keyBetween = `name: x
jobs:
  j:
    steps:
      - name: a
        run: echo hi
       uses: x
`;
  const errorsB = lintWorkflow(keyBetween, "wf");
  assert.ok(errorsB.length > 0, "a between-columns mapping key must not lint clean");
  assert.match(errorsB[0].message, /matches no open scope/);
});

test("legal nested sequences stay green (review finding on PR #11)", () => {
  const ok = `name: x
jobs:
  j:
    steps:
      - name: setup
        with:
          matrix:
            include:
              - os: mac
              - os: linux
      - name: env
        with:
          args:
            - one
            - two
`;
  assert.deepEqual(lintWorkflow(ok), []);

  // bare item whose content is a nested sequence
  const bare = `name: x
jobs:
  j:
    steps:
      -
        - plain
        - items
`;
  assert.deepEqual(lintWorkflow(bare), []);
});

test("all shipped workflow files lint clean (revert guard)", () => {
  const names = readdirSync(WF_DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
  assert.ok(names.length > 0, "expected shipped workflow files to exist");
  for (const f of names) {
    const errors = lintWorkflow(readFileSync(path.join(WF_DIR, f), "utf8"), f);
    assert.deepEqual(errors, [], `${f} must pass the structural lint`);
  }
});

test("gates.yml runs the structural lint over .yml and .yaml (revert guard)", () => {
  const gates = readFileSync(path.join(WF_DIR, "gates.yml"), "utf8");
  assert.match(gates, /node scripts\/workflow-lint\.mjs/,
    "the 'Workflow YAML parses' step must run the structural linter");
  assert.match(gates, /-name '\*\.yml' -o -name '\*\.yaml'/,
    "GitHub accepts both workflow extensions; the lint glob must cover .yaml too");
});

test("the pre-fix gate (tab-only check) was blind to this defect (regression proof)", () => {
  // Documents WHY the tab check alone was replaced: it passed the exact
  // content that 422'd every agent dispatch.
  withFile(BROKEN, (f) => {
    const old = spawnSync(process.execPath, ["-e",
      `const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');if(/\\t/.test(s))throw new Error('tab in '+process.argv[1])`,
      f], { encoding: "utf8" });
    assert.equal(old.status, 0, "old gate must pass the broken file (its blind spot)");
    const now = runTool([f]);
    assert.equal(now.status, 1, "new gate must reject the same file");
  });
});

test("unusable invocation is a loud usage error", () => {
  assert.equal(runTool([]).status, 2);
  const missing = runTool(["/nonexistent/wf.yml"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read/);
});
