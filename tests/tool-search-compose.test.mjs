// tool-search-compose.test.mjs — the composition search tool's pure core
// (plugins/tool-search-compose/lib/compose.js) and its packaging contract.
//
// Regression anchor: issue #40. The parked plugin documented `sortedBy` and
// `maxResults` it did not implement: `sortedBy: "modified"` was a silent
// no-op, and `maxResults` mapped to rg `--max-count`, which caps matches
// PER FILE — across N files it returned up to files × N, not the documented
// `| head` total. Ground truth pinned here against the ripgrep the fs-search
// seam ships (@vscode/ripgrep 15.0.0): there is NO `--max-results` flag (the
// total cap must be applied after the run) and `--count-matched` (the flag
// the parked plugin emitted) does not exist at all.
//
// These tests fail without the fix: re-add `--max-count=` to the argv and
// the no-per-file-cap pin goes red; drop the `--sort=` mapping and the
// sortedBy tests go red; make any validation lenient again and its test
// goes red; re-allow `context` beside `countOnly`/`filesOnly` (the silent
// one-sided combination the PR #43 review filed) and its test goes red.
//
// Coverage note (PR #43 review finding 1): gates' syntax loop walks
// `scripts/*` only and no test can IMPORT lib/index.js (it needs the dsh
// packages, absent from the gates' module path) — so the parse-only
// `node --check` test below is the ONLY gate coverage the boot-time file
// has. A syntax slip there must not keep every gate green behind a
// "search-compose: mounted" message.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SORT_MODES, buildRipgrepArgs, capResults } from "../plugins/tool-search-compose/lib/compose.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "tool-search-compose");
const LAUNCHER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

// --- 1. compose flags map to real ripgrep flags ---------------------------

test("compose flags map to real rg flags, pattern last-positional via --regexp", () => {
  // The default (context) shape...
  const argv = buildRipgrepArgs({
    pattern: "foo",
    ignoreCase: true,
    context: 2,
    include: "*.ts",
    path: "src",
  });
  assert.deepEqual(argv, [
    "-i",
    "--context=2",
    "--glob=*.ts",
    "--regexp=foo",
    "--",
    "src",
  ]);
  // ...and the counts shape — context may not ride along (rg would ignore
  // it; see the incompatibility test below).
  assert.deepEqual(
    buildRipgrepArgs({ pattern: "foo", countOnly: true, ignoreCase: true, include: "*.ts", path: "src" }),
    ["--count", "-i", "--glob=*.ts", "--regexp=foo", "--", "src"],
  );
});

test("countOnly emits --count, never the nonexistent --count-matched", () => {
  const argv = buildRipgrepArgs({ pattern: "foo", countOnly: true });
  assert.ok(argv.includes("--count"), "--count (the documented -c shape) present");
  assert.ok(!argv.includes("--count-matched"), "rg 15 rejects --count-matched; it must never be emitted");
});

test("filesOnly emits --files-with-matches", () => {
  const argv = buildRipgrepArgs({ pattern: "foo", filesOnly: true });
  assert.ok(argv.includes("--files-with-matches"));
});

// --- 2. maxResults: a TOTAL cap applied after the run, never a flag --------

test("maxResults emits NO ripgrep cap flag — neither per-file nor a phantom total one", () => {
  // The defect shape: `--max-count=N` caps PER FILE, so N files return up to
  // files × N matches — not the documented `| head` total. And rg has no
  // `--max-results` at all. The cap lives in capResults, post-run.
  const argv = buildRipgrepArgs({ pattern: "foo", maxResults: 5 });
  assert.deepEqual(
    argv.filter((a) => a.startsWith("--max-")),
    [],
    "no --max-* flag may ride on maxResults",
  );
});

test("capResults caps lines in TOTAL across files (the | head shape)", () => {
  // Three files' worth of matches in one stdout: a per-file cap would keep
  // 3 × 3 = 9 of these; the total cap keeps exactly 4.
  const out = ["a.txt:1", "b.txt:1", "b.txt:2", "b.txt:3", "c.txt:1", "c.txt:2", "c.txt:3"].join("\n") + "\n";
  assert.equal(capResults(out, 4), ["a.txt:1", "b.txt:1", "b.txt:2", "b.txt:3"].join("\n") + "\n");
});

test("capResults at or under the cap is byte-identical (trailing newline preserved)", () => {
  const out = "a.txt:1\nb.txt:1\n";
  assert.equal(capResults(out, 2), out, "exactly at the cap: unchanged");
  assert.equal(capResults(out, 99), out, "under the cap: unchanged");
  assert.equal(capResults(out, undefined), out, "unset: unchanged");
  assert.equal(capResults("", 5), "", "empty stdout stays empty");
});

test("capResults applies to the single-line shapes too (counts, file lists)", () => {
  const counts = ["a.txt:12", "b.txt:3", "c.txt:1"].join("\n") + "\n";
  assert.equal(capResults(counts, 2), "a.txt:12\nb.txt:3\n");
});

// --- 3. sortedBy: both modes honest, delegated to rg --sort ----------------

test("sortedBy path and modified map to rg --sort (file ordering, mtime ordering)", () => {
  assert.ok(buildRipgrepArgs({ pattern: "foo", sortedBy: "path" }).includes("--sort=path"));
  assert.ok(buildRipgrepArgs({ pattern: "foo", sortedBy: "modified" }).includes("--sort=modified"));
});

test("sortedBy composes with the line shapes (rg sorts counts and file lists too)", () => {
  const argv = buildRipgrepArgs({ pattern: "foo", sortedBy: "modified", countOnly: true });
  assert.deepEqual(argv, ["--count", "--sort=modified", "--regexp=foo"]);
});

test("sortedBy is never silently ignored: unknown values throw naming the value and the modes", () => {
  assert.throws(
    () => buildRipgrepArgs({ pattern: "foo", sortedBy: "size" }),
    (e) => e instanceof TypeError && /"size"/.test(e.message) && SORT_MODES.every((m) => e.message.includes(JSON.stringify(m))),
  );
});

// --- 4. typed validation: malformed arguments throw, nothing passes through -

test("malformed arguments throw TypeError naming the offending value", () => {
  const bad = [
    [{}, /pattern is required/],
    [{ pattern: "" }, /pattern is required/],
    [{ pattern: "foo", countOnly: true, filesOnly: true }, /mutually exclusive/],
    [{ pattern: "foo", context: 0 }, /context must be a positive integer/],
    [{ pattern: "foo", context: -1 }, /context must be a positive integer/],
    [{ pattern: "foo", context: 1.5 }, /context must be a positive integer/],
    [{ pattern: "foo", context: "2" }, /context must be a positive integer/],
    [{ pattern: "foo", maxResults: 0 }, /maxResults must be a positive integer/],
    [{ pattern: "foo", maxResults: -5 }, /maxResults must be a positive integer/],
    [{ pattern: "foo", maxResults: 2.5 }, /maxResults must be a positive integer/],
    [{ pattern: "foo", include: "" }, /include must be a non-empty glob string/],
    [{ pattern: "foo", path: "" }, /path must be a non-empty string/],
    [{ pattern: "foo", path: 7 }, /path must be a non-empty string/],
  ];
  for (const [args, re] of bad) assert.throws(() => buildRipgrepArgs(args), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(args));
});

test("capResults validates too (it is exported and callable without the builder)", () => {
  assert.throws(() => capResults("x\n", 0), /maxResults must be a positive integer/);
  assert.throws(() => capResults("x\n", -1), /maxResults must be a positive integer/);
});

// --- 5. context never rides silently beside the line shapes ----------------
// PR #43 review r1 finding 2: `rg --count --context=2` and
// `rg --files-with-matches --context=2` exit 0 with the context flag
// silently ignored — counts and file lists carry no context lines. The same
// silently-ignored-parameter class this tool exists to refuse, so the
// combination throws before rg runs.

test("context with countOnly or filesOnly is a typed error, never a silent drop", () => {
  for (const shape of [{ countOnly: true }, { filesOnly: true }]) {
    assert.throws(
      () => buildRipgrepArgs({ pattern: "foo", ...shape, context: 2 }),
      (e) => e instanceof TypeError && /context is incompatible with countOnly\/filesOnly/.test(e.message),
      JSON.stringify(shape),
    );
  }
  // The valid shapes stay valid: context alone, and either line shape alone.
  assert.ok(buildRipgrepArgs({ pattern: "foo", context: 2 }).includes("--context=2"));
  assert.ok(buildRipgrepArgs({ pattern: "foo", countOnly: true }).includes("--count"));
  assert.ok(buildRipgrepArgs({ pattern: "foo", filesOnly: true }).includes("--files-with-matches"));
});

// --- 6. packaging contract: package layout, pure core, overlay name pins ----

test("the plugin ships as a package the overlay can name (never a bare path again)", () => {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN, "package.json"), "utf8"));
  assert.equal(pkg.name, "@dsh-bot/tool-search-compose");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "lib/index.js");
  assert.ok(existsSync(path.join(PLUGIN, pkg.main)), "main entry exists");
  // The f2972e7 shape must stay dead: a bare-path overlay row pointed at the
  // in-tree index.js. The package layout is the thing that made the mount
  // resolvable — the old flat file must not quietly come back.
  assert.ok(!existsSync(path.join(PLUGIN, "index.js")), "no bare index.js beside the package root");
});

test("the whole package parse-checks — lib/index.js has no other gate (PR #43 review finding 1)", () => {
  // gates.yml's syntax loop walks scripts/* only, and no test can IMPORT
  // lib/index.js (its @deepseek-ai imports do not resolve on the gates'
  // module path). Parse-only checking needs no dsh runtime: this is the
  // only thing standing between a syntax slip in the boot-time file and a
  // dead mount that every gate called green.
  for (const rel of ["lib/index.js", "lib/compose.js"]) {
    const p = spawnSync(process.execPath, ["--check", path.join(PLUGIN, rel)], { encoding: "utf8" });
    assert.equal(p.status, 0, `${rel} must parse: ${p.stderr}`);
  }
  assert.equal(JSON.parse(readFileSync(path.join(PLUGIN, "package.json"), "utf8")).name, "@dsh-bot/tool-search-compose", "package.json parses");
});

test("compose.js stays dependency-free — the gates' module path has no dsh packages", () => {
  const src = readFileSync(path.join(PLUGIN, "lib", "compose.js"), "utf8");
  const importSources = [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(importSources, [], "the pure core imports nothing external (not even node builtins)");
});

test("the launcher stamps the same package name this package declares", () => {
  const script = readFileSync(LAUNCHER, "utf8");
  assert.match(script, /id: tool-search-compose/, "overlay row id pinned");
  assert.match(script, /name: '@dsh-bot\/tool-search-compose'/, "overlay row names the PACKAGE, not a path");
  assert.match(script, /DSH_SEARCH_COMPOSE/, "the mount is env-gated");
});

test("the superseded static overlay stub stays gone (its content was the bare-path form)", () => {
  assert.ok(!existsSync(path.join(ROOT, "config", "tool-overlay.yml")), "config/tool-overlay.yml must not return");
});
