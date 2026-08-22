#!/usr/bin/env node
// static-check.mjs — syntax gates for this bash + yaml + node toolkit.
//
//   node scripts/ci/static-check.mjs     (exit 1 on any failure)
//
// Checks:
//   1. bash -n on every shell script in scripts/ (shebang or *.sh).
//   2. node --check on every scripts/**/*.mjs file.
//   3. Every inline `node -e '<payload>'` in scripts/*.sh, .github/workflows
//      and examples/ is extracted and node --checked. Inline JS is exactly
//      how a regex literal split across lines shipped as a SyntaxError and
//      was silently swallowed by a fallback (drift-check run 32548668443):
//      invisible to bash -n, invisible to review, fatal at runtime. This
//      gate makes that class of bug visible in CI instead.
//
// The check functions are exported so the test suite can assert on them.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Every shell script directly in scripts/: *.sh or a *sh shebang file. */
export function shellScripts() {
  const dir = join(REPO, "scripts");
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      if (name.endsWith(".mjs") || name.endsWith(".js")) return false;
      if (!statSync(p).isFile()) return false;
      if (name.endsWith(".sh")) return true;
      return /^#!.*\b(?:ba|z|da)?sh\b/.test(readFileSync(p, "utf8").split("\n", 1)[0] ?? "");
    });
}

/** Every .mjs under scripts/, recursively (tool, ci checks, tests). */
export function mjsFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) out.push(p);
    }
  };
  walk(join(REPO, "scripts"));
  return out;
}

/** Files that may embed `node -e '...'` payloads. */
export function inlineNodeFiles() {
  return [
    ...shellScripts(),
    ...readdirSync(join(REPO, ".github", "workflows")).map((f) =>
      join(REPO, ".github", "workflows", f),
    ),
    ...readdirSync(join(REPO, "examples")).map((f) => join(REPO, "examples", f)),
  ];
}

/** Extract every single-quoted `node -e '...'` payload from a text file. */
export function extractInlineNodePayloads(text) {
  const out = [];
  const re = /\bnode\s+(?:-{2}[\w-]+\s+)*-e\s+'([^']*)'/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function nodeCheckCode(tmp, code) {
  // `node -e` evaluates CommonJS unless told otherwise; detect module syntax.
  const isEsm = /(^|\n)\s*(?:import|export)\s/.test(code);
  const f = join(tmp, `payload-${Math.random().toString(36).slice(2)}.${isEsm ? "mjs" : "js"}`);
  writeFileSync(f, code);
  return { file: f, res: spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }) };
}

/** Run every gate; returns [{ check, file, ok, detail }]. */
export function staticCheck() {
  const results = [];
  const push = (check, file, res) =>
    results.push({ check, file, ok: res.status === 0, detail: (res.stderr || res.stdout || "").trim() });

  for (const f of shellScripts()) {
    push("bash -n", f, spawnSync("bash", ["-n", f], { encoding: "utf8" }));
  }
  for (const f of mjsFiles()) {
    push("node --check", f, spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }));
  }

  const tmp = mkdtempSync(join(tmpdir(), "dsh-static-"));
  try {
    for (const f of inlineNodeFiles()) {
      let text;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const payload of extractInlineNodePayloads(text)) {
        const { file, res } = nodeCheckCode(tmp, payload);
        push("inline node -e syntax", f, res);
        rmSync(file, { force: true });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

function rel(p) {
  return p.startsWith(REPO) ? p.slice(REPO.length + 1) : p;
}

export function printResults(results) {
  const bad = results.filter((r) => !r.ok);
  for (const r of results.filter((r) => r.ok)) {
    console.log(`ok       ${r.check}  ${rel(r.file)}`);
  }
  for (const r of bad) {
    console.error(`FAIL     ${r.check}  ${rel(r.file)}`);
    if (r.detail) console.error(r.detail.split("\n").slice(0, 12).join("\n"));
  }
  return bad.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = staticCheck();
  const failed = printResults(results);
  console.log(`\nstatic-check: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
