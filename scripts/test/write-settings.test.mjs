// write-settings.test.mjs — behavioral tests for the settings overlay.
//
// Regression background (drift-check run 32548668443): the overlay used to
// be an inline `node -e` one-liner in the driver with a `|| cp` fallback.
// When its regex broke, every DSH_MODEL override silently no-oped while the
// log claimed "run model: … (overridden)". These tests pin the new
// fail-closed contract: an override either verifiably lands or the tool
// exits nonzero. Several cases below fail against the old overlay logic.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(ROOT, "scripts", "write-settings.mjs");
const TEMPLATE = join(ROOT, "config", "settings.zai.yaml");

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { rc: r.status, err: r.stderr, out: r.stdout };
}

/** Independent re-implementation of the read side (no shared code with the
 *  tool, so a bug in the tool's parser cannot hide behind itself). */
function parseAgentDefaultModel(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^agent-default-model:\s*$/.test(l));
  if (start === -1) return null;
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z][\w.-]*:/.test(lines[i])) break;
    const m = /^ {2}([\w.-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1] === "provider" || m[1] === "model") out[m[1]] = m[2].trim();
  }
  return out.provider && out.model ? out : null;
}

function catalogIds(text) {
  return [...text.matchAll(/^\s*- id:\s*(\S+)$/gm)].map((m) => m[1]);
}

let TMP;
test.beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "dsh-ws-"));
});
test.afterEach(() => rmSync(TMP, { recursive: true, force: true }));

test("applies the requested model to the fleet template, touching nothing else", () => {
  const dest = join(TMP, "settings.yaml");
  const r = run([TEMPLATE, "zai/glm-4.5-air", dest]);
  assert.equal(r.rc, 0, `stderr: ${r.err}`);
  assert.equal(r.out, "", "success must be silent on stdout");

  const got = parseAgentDefaultModel(readFileSync(dest, "utf8"));
  assert.deepEqual(got, { provider: "zai", model: "glm-4.5-air" });

  // Everything outside the agent-default-model block is byte-identical:
  // the provider/models catalog must survive an override untouched.
  const before = readFileSync(TEMPLATE, "utf8").split("\n");
  const after = readFileSync(dest, "utf8").split("\n");
  assert.equal(before.length, after.length);
  const diffs = before
    .map((l, i) => [l, after[i]])
    .filter(([b, a]) => b !== a);
  assert.deepEqual(diffs, [["  model: glm-5.3", "  model: glm-4.5-air"]]);
  assert.deepEqual(catalogIds(readFileSync(dest, "utf8")), catalogIds(readFileSync(TEMPLATE, "utf8")));
});

test("rewriting with the template default is a byte-for-byte no-op", () => {
  const dest = join(TMP, "settings.yaml");
  const r = run([TEMPLATE, "zai/glm-5.3", dest]);
  assert.equal(r.rc, 0, `stderr: ${r.err}`);
  assert.equal(readFileSync(dest, "utf8"), readFileSync(TEMPLATE, "utf8"));
});

test("rewrites provider too on foreign routes (old overlay left the stale provider)", () => {
  // scripts/run-dsh-agent.sh documents DSH_MODEL=opencode-go2/deepseek-v4-flash;
  // the old single-regex overlay rewrote only `model:`, silently producing
  // provider zai + a foreign model id — a mismatched route.
  const dest = join(TMP, "settings.yaml");
  const r = run([TEMPLATE, "opencode-go2/deepseek-v4-flash", dest]);
  assert.equal(r.rc, 0, `stderr: ${r.err}`);
  assert.deepEqual(parseAgentDefaultModel(readFileSync(dest, "utf8")), {
    provider: "opencode-go2",
    model: "deepseek-v4-flash",
  });
});

test("template with a trailing comment on the model line still applies (old overlay silently no-oped)", () => {
  const tmpl = join(TMP, "tmpl.yaml");
  writeFileSync(
    tmpl,
    readFileSync(TEMPLATE, "utf8").replace("  model: glm-5.3", "  model: glm-5.3   # fleet default"),
  );
  const dest = join(TMP, "settings.yaml");
  const r = run([tmpl, "zai/glm-5.2", dest]);
  assert.equal(r.rc, 0, `stderr: ${r.err}`);
  const got = parseAgentDefaultModel(readFileSync(dest, "utf8"));
  assert.deepEqual(got, { provider: "zai", model: "glm-5.2" });
});

test("quoted template values are recognized and replaced", () => {
  const tmpl = join(TMP, "tmpl.yaml");
  writeFileSync(
    tmpl,
    readFileSync(TEMPLATE, "utf8")
      .replace("  provider: zai", '  provider: "zai"')
      .replace("  model: glm-5.3", '  model: "glm-5.3"'),
  );
  const dest = join(TMP, "settings.yaml");
  const r = run([tmpl, "zai/glm-5.1", dest]);
  assert.equal(r.rc, 0, `stderr: ${r.err}`);
  assert.deepEqual(parseAgentDefaultModel(readFileSync(dest, "utf8")), {
    provider: "zai",
    model: "glm-5.1",
  });
});

test("fails closed when the template has no agent-default-model block", () => {
  const tmpl = join(TMP, "tmpl.yaml");
  writeFileSync(
    tmpl,
    readFileSync(TEMPLATE, "utf8")
      .split("\n")
      .filter((l) => !/^agent-default-model:$/.test(l) && !/^  provider: zai$/.test(l) && !/^  model: glm-5\.3$/.test(l))
      .join("\n"),
  );
  const dest = join(TMP, "settings.yaml");
  const r = run([tmpl, "zai/glm-5.2", dest]);
  assert.notEqual(r.rc, 0);
  assert.match(r.err, /agent-default-model/);
  assert.equal(existsSync(dest), false, "must not write a dest it could not verify");
});

test("fails closed when the block lacks a model: child", () => {
  const tmpl = join(TMP, "tmpl.yaml");
  writeFileSync(
    tmpl,
    readFileSync(TEMPLATE, "utf8").split("\n").filter((l) => !/^  model: glm-5\.3$/.test(l)).join("\n"),
  );
  const dest = join(TMP, "settings.yaml");
  const r = run([tmpl, "zai/glm-5.2", dest]);
  assert.notEqual(r.rc, 0);
  assert.match(r.err, /'model:' child/);
  assert.equal(existsSync(dest), false);
});

test("rejects malformed model routes", () => {
  const dest = join(TMP, "settings.yaml");
  for (const bad of ["glm-5.3", "zai/", "/glm-5.3", "z ai/glm-5.3", "zai/glm 5.3"]) {
    const r = run([TEMPLATE, bad, dest]);
    assert.notEqual(r.rc, 0, `route '${bad}' must be rejected`);
    assert.match(r.err, /provider\/model/);
  }
  assert.equal(existsSync(dest), false);
});

test("fails closed on an unreadable template", () => {
  const dest = join(TMP, "settings.yaml");
  const r = run([join(TMP, "missing.yaml"), "zai/glm-5.2", dest]);
  assert.notEqual(r.rc, 0);
  assert.match(r.err, /cannot read template/);
});

test("usage error on wrong argument count", () => {
  const r = run([TEMPLATE, "zai/glm-5.2"]);
  assert.notEqual(r.rc, 0);
  assert.match(r.err, /usage:/);
});
