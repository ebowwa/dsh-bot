// static-guards.test.mjs — the gates that keep the run-32548668443 class of
// bug out of this repo:
//
//   * every shell script passes `bash -n`; every .mjs passes `node --check`
//   * every inline `node -e '<payload>'` in scripts/, workflows and examples
//     is extracted and syntax-checked (the incident's broken payload — a
//     regex literal split across lines inside `node -e` — is replayed here
//     and must be caught)
//   * the driver applies models via write-settings.mjs with no masking
//     fallback, and carries no inline JS at all
//   * boundary invariants hold (agent-loop exec only in the driver; config
//     references credentials by env name only)

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { staticCheck, extractInlineNodePayloads } from "../ci/static-check.mjs";
import { archCheck, INLINE_NODE_RE } from "../ci/arch-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = join(ROOT, "scripts", "run-dsh-agent.sh");

test("all static syntax gates pass (bash -n, node --check, inline node -e payloads)", () => {
  const results = staticCheck();
  assert.ok(results.length >= 5, `expected the gates to actually run, got ${results.length}`);
  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(
    failed.map((r) => `${r.check} ${r.file}: ${r.detail.split("\n")[0]}`),
    [],
    "static syntax gates must be green",
  );
});

test("all architecture boundary invariants hold", () => {
  assert.deepEqual(archCheck(), []);
});

test("run 32548668443 regression: the shipped broken payload is caught by the inline gate", () => {
  // The exact shape that shipped inside scripts/run-dsh-agent.sh at
  // dd1fc36: a regex literal reformatted across lines inside `node -e '…'`.
  const broken = `
    const doc = fs.readFileSync(p, "utf8");
    const out = doc.replace(/^agent-default-model:
  (?:[ \\t].*
  )*[ \\t]*provider:.*
  [ \\t]*model:.*$/m,
      \`agent-default-model:
    provider: \${provider}
    model: \${model}\`);
    fs.writeFileSync(p, out);
  `;
  const tmp = mkdtempSync(join(tmpdir(), "dsh-regr-"));
  try {
    const f = join(tmp, "payload.js");
    writeFileSync(f, broken);
    const res = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    assert.notEqual(res.status, 0, "the historical payload is a SyntaxError and must fail --check");
    assert.match(res.stderr, /SyntaxError|Invalid regular expression|Unterminated/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // And the extractor must find such payloads where they hide (single-quoted,
  // multi-line) so the gate can reach them.
  const synthetic = `#!/usr/bin/env bash\nnode -e '${broken}' "$f"\n`;
  const payloads = extractInlineNodePayloads(synthetic);
  assert.equal(payloads.length, 1);
  assert.ok(payloads[0].includes("doc.replace(/^agent-default-model:"));
});

test("driver applies models via write-settings.mjs with no masking fallback", () => {
  const src = readFileSync(DRIVER, "utf8");
  assert.match(
    src,
    /node "\$SCRIPT_DIR\/write-settings\.mjs"/,
    "the settings overlay must go through the verifiable tool",
  );
  assert.doesNotMatch(
    src,
    INLINE_NODE_RE,
    "the driver must not embed inline `node -e` JS (use a checkable .mjs)",
  );
  assert.ok(
    !src.includes('|| cp "$SETTINGS_TEMPLATE"'),
    "a template-copy fallback silently downgrades model overrides to the fleet default",
  );
});
