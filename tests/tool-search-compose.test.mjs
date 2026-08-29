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
// goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SORT_MODES, buildRipgrepArgs, capResults } from "../plugins/tool-search-compose/lib/compose.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "tool-search-compose");
const LAUNCHER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

// --- 1. compose flags map to real ripgrep flags ---------------------------

test("compose flags map to real rg flags, pattern last-positional via --regexp", () => {
  const argv = buildRipgrepArgs({
    pattern: "foo",
    countOnly: true,
    filesOnly: false,
    ignoreCase: true,
    context: 2,
    include: "*.ts",
    path: "src",
  });
  assert.deepEqual(argv, [
    "--count",
    "-i",
    "--context=2",
    "--glob=*.ts",
    "--regexp=foo",
    "--",
    "src",
  ]);
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

// --- 5. packaging contract: package layout, pure core, overlay name pins ----

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
