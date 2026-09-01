// search-compose-mount.test.mjs — the launcher side of the composition
// search tool mount (scripts/run-dsh-agent.sh section 2f, DSH_SEARCH_COMPOSE).
//
// Regression anchor: issue #40 / f2972e7. The first --patch mount of this
// plugin crashed EVERY agent launch: the overlay named the bare in-tree
// script path, which resolves relative to the profile directory and satisfies
// no bare `@deepseek-ai/*` import. The mount now packages the plugin and
// copies it into the profile module tree before stamping the overlay — and
// default-off, so unset stays a byte-identical launch line.
//
// These tests fail without the fix: unset DSH_SEARCH_COMPOSE with a stray
// unconditional --patch in the launcher and test 1 goes red; break the
// copy/stamp/--patch chain and test 2 goes red; make the incomplete-package
// check limp and test 4 goes red; drop the same-tree guard and test 5
// deletes its own source (cp: cannot stat, red).
//
// Tests 6-7 are the live half, skipped when the dsh CLI is absent (dev
// machines keep stub-level coverage; the dsh lanes run them): --dump-config
// must show the insert row composing into the real profile (NOT warn-and-
// skip — which also exits 0, so presence is the assertion), and a real boot
// with every inference credential stripped must reach MISSING_CREDENTIAL —
// proof the packaged plugin's tree LOADS against the stamped overlay (the
// same dump-green/boot-dead defect class sections 9-10 of
// run-dsh-agent.test.mjs pin for the subagent stamp).
//
// Harness modeled on run-dsh-agent.test.mjs's runLauncher (doppler stub execs
// through; a recording dsh stub captures argv AND every --patch file's
// content; a persistent DSH_HOME so the stamped artifacts survive).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const PLUGIN = path.join(ROOT, "plugins", "tool-search-compose");
const DSH_PRESENT = spawnSync("dsh", ["--version"]).status === 0;

// A launcher script + its two runtime script deps, rooted at `base`, with an
// optional plugins/tool-search-compose layout. Running a COPY (not the repo)
// is how the incomplete-package case constructs absence without touching the
// working tree.
const materializeLauncher = (base, { withPlugin = true, pluginFiles = null } = {}) => {
  mkdirSync(path.join(base, "scripts"), { recursive: true });
  for (const f of ["run-dsh-agent.sh", "scrub-output.mjs"]) {
    cpSync(path.join(ROOT, "scripts", f), path.join(base, "scripts", f));
  }
  // The settings template the launcher reads from $SCRIPT_DIR/../config —
  // present in every real deployment; without it the copy would fall into
  // the launcher's $REPO_ROOT fallback branch, a layout the lanes never run.
  mkdirSync(path.join(base, "config"), { recursive: true });
  cpSync(path.join(ROOT, "config", "settings.zai.yaml"), path.join(base, "config", "settings.zai.yaml"));
  if (withPlugin) {
    cpSync(PLUGIN, path.join(base, "plugins", "tool-search-compose"), { recursive: true });
    for (const rel of pluginFiles ?? []) rmSync(path.join(base, "plugins", "tool-search-compose", rel));
  }
  return path.join(base, "scripts", "run-dsh-agent.sh");
};

// Run the launcher with stub cell tools and a persistent DSH_HOME; the dsh
// stub records argv and the content of every --patch overlay it is handed.
const runLauncher = (extraEnv = {}, { script = SCRIPT, dshHome = null } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-compose-mount-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner");
  const argsFile = path.join(dir, "dsh-args.txt");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift; shift; shift\nexec \"$@\"\n");
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      'printf "%s\\n" "$@" > "$STUB_ARGS_FILE"',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--patch" ]; then',
      '    echo "--- patch file: $a ---" >> "$STUB_ARGS_FILE"',
      '    cat "$a" >> "$STUB_ARGS_FILE" 2>/dev/null || echo "(unreadable)" >> "$STUB_ARGS_FILE"',
      "  fi",
      '  prev="$a"',
      "done",
      "echo STUB-OK",
      "exit 0",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_HOME: dshHome ?? home,
    DSH_PERSISTENT_HOME: "1",
    STUB_ARGS_FILE: argsFile,
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.RUNNER_NAME;
  delete env.DSH_MODEL;
  delete env.DSH_SUBAGENT_MODEL;
  delete env.DSH_WEB_SEARCH_CELLS;
  delete env.DSH_SEARCH_COMPOSE;
  // extraEnv LAST: the per-test overrides must survive the base scrub above.
  Object.assign(env, extraEnv);

  const proc = spawnSync("bash", [script, "compose mount test task"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  const args = existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "";
  return { proc, dir, home, args };
};

test("DSH_SEARCH_COMPOSE unset: byte-identical launch line — no --patch, no overlay, no copy", () => {
  const { proc, home, args } = runLauncher({});
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  assert.ok(!args.includes("--patch"), `no --patch when unset, got argv: ${args}`);
  assert.ok(!existsSync(path.join(home, "search-compose.patch.yml")), "no overlay stamped when unset");
  assert.ok(
    !existsSync(path.join(home, "profiles", "node_modules", "@dsh-bot")),
    "no plugin copy when unset",
  );
});

test("DSH_SEARCH_COMPOSE=1: copies the package, stamps the insert overlay, passes --patch", () => {
  const { proc, home, args } = runLauncher({ DSH_SEARCH_COMPOSE: "1" });
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  assert.match(proc.stderr, /search-compose: mounted for this run/);

  // The package lands in the profile module tree, complete — this is the
  // f2972e7 fix: deps resolve THROUGH the tree, so the copy must be whole.
  const dst = path.join(home, "profiles", "node_modules", "@dsh-bot", "tool-search-compose");
  for (const rel of ["package.json", "lib/index.js", "lib/compose.js"]) {
    assert.ok(existsSync(path.join(dst, rel)), `copied package carries ${rel}`);
  }
  const copied = JSON.parse(readFileSync(path.join(dst, "package.json"), "utf8"));
  assert.equal(copied.name, "@dsh-bot/tool-search-compose");

  // The overlay names the PACKAGE with the insert grammar — never a path.
  const overlay = path.join(home, "search-compose.patch.yml");
  assert.ok(existsSync(overlay), "overlay stamped");
  const body = readFileSync(overlay, "utf8");
  assert.match(body, /- insert:\n    - id: tool-search-compose\n      name: '@dsh-bot\/tool-search-compose'/);
  assert.ok(!/name: \.\/|name: ['"]?\.{0,2}\//.test(body.replace(/#.*$/gm, "")), "no bare-path row (the f2972e7 shape)");

  // And the launch line carries it: --patch directly after --profile headless
  // (this is the only patch in a compose-only run).
  const lines = args.split("\n").filter((l) => l !== "" && !l.startsWith("---") && !l.startsWith("#"));
  const patchAt = lines.indexOf("--patch");
  assert.ok(patchAt > 0, `dsh must receive --patch, got argv: ${lines.join(" ")}`);
  assert.equal(lines[patchAt - 1], "headless", "--patch follows --profile headless");
  assert.equal(lines[patchAt + 1], overlay, "--patch names the stamped overlay");
});

test("the compose mount composes with the subagent-model mount (both overlays ride)", () => {
  const { proc, args } = runLauncher({ DSH_SEARCH_COMPOSE: "1", DSH_SUBAGENT_MODEL: "zai/glm-5-turbo" });
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  for (const overlay of ["subagent-model.patch.yml", "search-compose.patch.yml"]) {
    assert.ok(args.includes(overlay), `${overlay} must ride alongside the other`);
  }
  assert.match(args, /- id: tool-subagent\n/, "the subagent overlay content survived composition");
});

test("incomplete package fails loud before any launch (a dead mount must never look working)", () => {
  const base = mkdtempSync(path.join(tmpdir(), "dsh-compose-incomplete-"));
  try {
    // The launcher copy WITHOUT package.json: the exact "missing or
    // incomplete" provisioning state the check exists for.
    const script = materializeLauncher(base, { pluginFiles: ["package.json"] });
    const { proc, args } = runLauncher({ DSH_SEARCH_COMPOSE: "1" }, { script });
    assert.equal(proc.status, 2, "incomplete package must exit 2");
    assert.match(proc.stderr, /missing or incomplete/);
    assert.match(proc.stderr, /need package\.json \+ lib\/index\.js/);
    assert.equal(args, "", "dsh must never be launched on an incomplete mount");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("same-tree guard: a DSH_HOME at the plugin itself copies nothing and deletes no source", () => {
  const base = mkdtempSync(path.join(tmpdir(), "dsh-compose-sametree-"));
  try {
    // Alias the launcher's SOURCE prefix onto the DESTINATION prefix with a
    // symlink, so both resolve to one physical directory — the only way the
    // guard's equality ever trips on a real filesystem:
    //   SRC = <scripts>/../plugins/tool-search-compose
    //   DST = <home>/profiles/node_modules/@dsh-bot/tool-search-compose
    const home = path.join(base, "home");
    const modules = path.join(home, "profiles", "node_modules");
    mkdirSync(path.join(modules, "scripts"), { recursive: true });
    mkdirSync(path.join(modules, "config"), { recursive: true });
    cpSync(path.join(ROOT, "scripts", "run-dsh-agent.sh"), path.join(modules, "scripts", "run-dsh-agent.sh"));
    cpSync(path.join(ROOT, "scripts", "scrub-output.mjs"), path.join(modules, "scripts", "scrub-output.mjs"));
    cpSync(path.join(ROOT, "config", "settings.zai.yaml"), path.join(modules, "config", "settings.zai.yaml"));
    const pkgDir = path.join(modules, "@dsh-bot", "tool-search-compose");
    cpSync(PLUGIN, pkgDir, { recursive: true });
    symlinkSync(path.join("@dsh-bot"), path.join(modules, "plugins"), "dir");
    const { proc, args } = runLauncher(
      { DSH_SEARCH_COMPOSE: "1" },
      { script: path.join(modules, "scripts", "run-dsh-agent.sh"), dshHome: home },
    );
    assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
    assert.match(proc.stderr, /same-tree guard/);
    assert.ok(existsSync(path.join(pkgDir, "package.json")), "the source survived (no rm -rf of the copy's own origin)");
    assert.ok(existsSync(path.join(pkgDir, "lib", "index.js")), "the source is still complete");
    assert.ok(args.includes("search-compose.patch.yml"), "the overlay still rides");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- live half: real dsh only (the lanes; skipped on dsh-less machines) ----

test("the stamped overlay composes into the real profile: the insert row resolves, not warn-and-skips (skip when dsh is absent)", { skip: !DSH_PRESENT }, () => {
  const { home } = runLauncher({ DSH_SEARCH_COMPOSE: "1" });
  const overlay = path.join(home, "search-compose.patch.yml");
  assert.ok(existsSync(overlay), "overlay stamped");
  // The dump MUST run against the launcher's own home: the package copy the
  // insert row names lives in THIS profile tree. An isolated home would
  // warn-and-skip the row and still exit 0 — the silently-dead shape.
  const dump = spawnSync(
    "dsh",
    ["--profile", "headless", "--patch", overlay, "--dump-config"],
    { encoding: "utf8", env: { ...process.env, DSH_HOME: home }, timeout: 60_000 },
  );
  assert.equal(dump.status, 0, `dump-config must compose, stderr: ${dump.stderr}`);
  assert.match(dump.stdout, /- id: tool-search-compose\n\s+name: ['"]@dsh-bot\/tool-search-compose['"]/, "the insert row must appear in the composed config");
});

test("the packaged plugin's tree BOOTS against the stamped overlay (skip when dsh is absent)", { skip: !DSH_PRESENT }, () => {
  const { proc, home } = runLauncher({ DSH_SEARCH_COMPOSE: "1" });
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  const overlay = path.join(home, "search-compose.patch.yml");
  assert.ok(existsSync(overlay), "overlay stamped by the launcher run");
  assert.ok(
    existsSync(path.join(home, "profiles", "node_modules", "@dsh-bot", "tool-search-compose", "lib", "index.js")),
    "the package copy the overlay names is in place",
  );

  const cwd = mkdtempSync(path.join(tmpdir(), "dsh-compose-bootcwd-"));
  // Strip every plausible inference credential: the boot must die at
  // credential resolution (fast, offline), never place a live call.
  const env = { ...process.env, DSH_HOME: home };
  for (const k of ["ZAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DOPPLER_SERVICE_TOKEN"]) delete env[k];
  try {
    const boot = spawnSync("dsh", ["--profile", "headless", "--patch", overlay, "reply ok"], {
      encoding: "utf8",
      timeout: 120_000,
      cwd,
      env,
    });
    assert.notEqual(boot.status, null, "the boot probe must terminate, not hang");
    const combined = `${boot.stdout}\n${boot.stderr}`;
    assert.match(
      combined,
      /MISSING_CREDENTIAL/,
      "the boot must reach credential resolution — proving the whole tree, this plugin included, loaded",
    );
    assert.doesNotMatch(
      combined,
      /plugin tree failed to load/,
      "the profile must LOAD against the stamped overlay — this signature is the dump-green/boot-dead defect class",
    );
    assert.doesNotMatch(
      combined,
      /Cannot find package/,
      "both @deepseek-ai imports must resolve through the profile's flat fallback (the f2972e7 signature)",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
