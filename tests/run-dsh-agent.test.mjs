// run-dsh-agent.test.mjs — tests for scripts/run-dsh-agent.sh.
//
// Regression anchor: drift-check run 32797020619. The launcher line gained
// a `#` comment INSIDE a backslash continuation (the --patch overlay mount
// at 236c706), which silently severed the command: `doppler run ... env -u
// ...` ran with no utility (an env dump), and `dsh ... --patch
// "$DSH_BOT_DIR/..."` executed as its own line — unbound variable, dead
// agent, red run. That instance was reverted (f2972e7, run 32798068670
// green), but the failure exposed two defects still live on main:
//
//   1. `session_file: unbound variable` (line 246 of that run): the
//      progress streamer probed `kill -0` on an already-dead wrapper pid,
//      broke out of the loop before `session_file` was ever assigned, and
//      set -u aborted the function instead of degrading gracefully.
//   2. `wait "$DSH_PID"` + set -e: a nonzero agent exit aborted the whole
//      script at the wait — before the transcript cleanup, before the
//      final answer was relayed from $FINAL_OUT, before the job-scoped
//      home was removed. The failed run left its home on the runner.
//
// These tests fail without the fix: revert the `local ... session_file=""`
// or the `RC=0; wait ... || RC=$?` lines and tests 1-2 go red. Test 3 is
// the class guard (a comment line inside a continuation must never merge
// green again — same posture as workflow-lint's run-32705244305 suite) and
// passes on the parent by design: the defect instance was already reverted
// there; what it pins is that it cannot come back unnoticed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");

// Extract one shell function from the script by name (sed range from the
// `name()` definition line to the closing brace at column 0).
const extractFunction = (name) =>
  spawnSync("sed", ["-n", `/^${name}()/,/^}/p`, SCRIPT], { encoding: "utf8" }).stdout;

// A pid that is guaranteed dead AND reaped: spawn a child, resolve after
// its exit event fires (node reaps its children), then use its pid.
const reapedPid = () =>
  new Promise((resolve) => {
    const p = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
    p.on("exit", () => resolve(p.pid));
  });

// --- 1. the streamer must degrade gracefully, not die on set -u ---------

test("stream_session_progress degrades gracefully when the wrapper pid is already dead (run 32797020619, line 246)", async () => {
  const fn = extractFunction("stream_session_progress");
  assert.ok(fn.includes("stream_session_progress()"), "function extracted from script");

  // zstd must exist for the function to proceed past its guards — a stub
  // keeps the test deterministic on runners without zstd.
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-streamer-test-"));
  writeFileSync(path.join(dir, "zstd"), "#!/bin/sh\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(dir, "zstd")]);

  const dead = await reapedPid();
  const proc = spawnSync(
    "bash",
    [
      "-euo", "pipefail",
      "-c",
      `${fn}
       stream_session_progress /nonexistent-marker ${dead}`,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  );
  rmSync(dir, { recursive: true, force: true });

  assert.equal(proc.status, 0, `streamer must exit 0, got stderr: ${proc.stderr}`);
  assert.match(
    proc.stderr,
    /no live session file found; progress unavailable/,
    "the graceful-degradation message must replace the unbound-variable abort",
  );
});

// --- 2. a failed agent run must still clean up and relay the answer -----

test("a nonzero agent exit still relays the final answer, cleans the job-scoped home, and exits nonzero (run 32797020619 wait/set-e abort)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-agent-failpath-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  // doppler stub: `doppler run --token <tok> -- <cmd...>` -> exec <cmd...>
  writeFileSync(
    path.join(bin, "doppler"),
    "#!/bin/sh\nshift; shift; shift; shift\nexec \"$@\"\n",
  );
  // dsh stub: answers --version, then fails immediately (the failure path)
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      "echo STUB-FINAL-ANSWER",
      "exit 1",
    ].join("\n") + "\n",
  );
  // zstd stub: the progress streamer's availability guard
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  // gh stub + explicit BIN seams + empty probe list: the driver's cell-tools
  // bootstrap must stay hermetic here — no prefix probing (it would shadow
  // the stub doppler on doppler-equipped machines) and no gh network
  // install on gh-less machines (review r1 finding 5, extended to doppler).
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_KEEP_SESSIONS: "", // default path: transcripts must be cleaned
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN;      // skip the gh-identity block entirely
  delete env.GITHUB_ENV;    // no workflow env file to publish to
  delete env.DSH_HOME;      // force the job-scoped home under RUNNER_TEMP
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;

  const proc = spawnSync(
    "bash",
    [SCRIPT, "integration test task"],
    { encoding: "utf8", env, timeout: 60_000 },
  );

  // The agent failure must SURFACE (REVIEW.md: no swallowed exits) ...
  assert.equal(proc.status, 1, "agent exit code must propagate, not be swallowed");
  // ... but only after the run's own contracts ran:
  assert.match(
    proc.stdout,
    /STUB-FINAL-ANSWER/,
    "the final answer must be relayed from $FINAL_OUT even on failure",
  );
  const homes = readdirSync(runnerTemp).filter((f) => f.startsWith("dsh-home."));
  assert.deepEqual(
    homes,
    [],
    "the job-scoped home must be removed on failure (secrets/transcripts must not survive on the runner)",
  );

  rmSync(dir, { recursive: true, force: true });
});

// --- 2b. soft gh end-to-end: the WHOLE driver must survive a failed gh
// bootstrap and still launch the agent (review r2 finding 2's
// integration half). The extracted-function pins in cell-tools.test.mjs
// prove ensure_cell_tools degrades under `set -euo pipefail`; this test
// proves the REAL script — flags, early sections, doppler exec and all —
// reaches the agent path instead of dying with curl's exit code. On the
// r1 code (GH_VER resolve unguarded) the driver aborted with curl's bare
// exit 7 before the warning, before the agent.

test("gh uninstallable (no egress): the full driver still launches the agent and exits with ITS code, not curl's (review r2 finding 2)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-agent-softgh-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(runnerTemp);

  // doppler stub: `doppler run --token <tok> -- <cmd...>` -> exec <cmd...>
  writeFileSync(
    path.join(bin, "doppler"),
    "#!/bin/sh\nshift; shift; shift; shift\nexec \"$@\"\n",
  );
  // dsh stub: answers --version, then succeeds with a final answer
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      "echo STUB-FINAL-ANSWER",
      "exit 0",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  // NO gh stub: GH_BIN points at /nonexistent — gh is absent everywhere.
  // curl shim: no egress — the gh version-resolve dies with curl's exit 7
  // and a stderr message the resolve-failure path must surface as a tail.
  writeFileSync(
    path.join(bin, "curl"),
    "#!/bin/sh\necho 'curl: (7) simulated: no route to host' >&2\nexit 7\n",
  );
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_HOME: home,
    DSH_PERSISTENT_HOME: "1",
    GH_BIN: "/nonexistent/gh",
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN;      // skip the gh-identity block entirely
  delete env.GITHUB_ENV;    // no workflow env file to publish to
  delete env.GITHUB_PATH;   // no workflow path file to append to
  delete env.DSH_SESSION_PATH_FILE;

  const proc = spawnSync("bash", [SCRIPT, "soft-gh integration test task"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });

  assert.notEqual(proc.status, 7, "the driver must NOT die with curl's exit code");
  assert.equal(proc.status, 0, `the agent ran and exited 0; stderr tail: ${proc.stderr.split("\n").slice(-6).join("\n")}`);
  assert.match(proc.stdout, /STUB-FINAL-ANSWER/, "the driver must reach the agent — its final answer is relayed");
  assert.match(proc.stderr, /could not resolve latest gh release:/, "the resolve failure must say so");
  assert.match(proc.stderr, /curl: \(7\) simulated: no route to host/, "curl's stderr tail must surface in the hint (404 vs no-egress)");
  assert.match(proc.stderr, /::warning::gh unavailable on this cell/, "gh is soft: warning, not death");

  rmSync(dir, { recursive: true, force: true });
});

// --- 3. the class guard: no comment inside a backslash continuation -----

test("scripts never place a comment line inside a backslash continuation (run 32797020619 class)", () => {
  const scriptsDir = path.join(ROOT, "scripts");
  const shFiles = readdirSync(scriptsDir).filter((f) => f.endsWith(".sh"));
  assert.ok(shFiles.length > 0, "scripts/ sh files found");

  const offenders = [];
  for (const f of shFiles) {
    const lines = readFileSync(path.join(scriptsDir, f), "utf8").split(/\r?\n/);
    for (let i = 0; i + 1 < lines.length; i++) {
      // A line joins its successor only if it ends in an ODD number of
      // backslashes (`\\` is an escaped backslash, not a continuation).
      const trailing = lines[i].match(/\\+$/);
      if (!trailing || trailing[0].length % 2 === 0) continue;
      // The joined line begins with `#`: bash treats it as a comment start,
      // the continuation is severed, and everything after it runs as a
      // SEPARATE command (in 32797020619: dsh launched outside doppler,
      // referencing an unbound $DSH_BOT_DIR). bash -n passes this shape —
      // only a structural check can catch it.
      if (/^\s*#/.test(lines[i + 1])) {
        offenders.push(`${f}:${i + 2} (continuation from line ${i + 1})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "comment line(s) inside a backslash continuation — the run-32797020619 defect class:\n" +
      offenders.join("\n"),
  );
});

// Sanity: the script under test is the one the gates lint (bash -n parity).
test("run-dsh-agent.sh parses (bash -n)", () => {
  assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
  assert.ok(existsSync(SCRIPT));
});

// --- 4-7. DSH_SUBAGENT_MODEL: route subagent/subagent_fork children to a
// different model than the head (issue #220: "submodels also use the turbo
// model"). Contract: unset = inherit = byte-identical launch line; set =
// a regenerated patch overlay + --patch flag. The overlay restates the
// plugin config wholesale (a patch row REPLACES it — provider/toolName/
// backgroundMode included), which is why test 7 also pins those restated
// values against the live headless profile: if the bundle ever changes
// them, the stamp must be updated in the same commit, not drift.

// Shared harness: stub doppler (exec through) + recording dsh stub, run the
// real launcher against a PERSISTENT (externally-supplied) DSH_HOME so the
// stamped artifacts survive for inspection (a job-scoped home is rm -rf'd
// at exit — test 2 pins that path; these tests need the files).
const runLauncher = (extraEnv = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-subagent-model-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner");
  const argsFile = path.join(dir, "dsh-args.txt");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(
    path.join(bin, "doppler"),
    "#!/bin/sh\nshift; shift; shift; shift\nexec \"$@\"\n",
  );
  // dsh stub: --version answers, otherwise record argv; when --patch <file>
  // appears, also capture the overlay content (the thing under test).
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
      '  fi',
      '  prev="$a"',
      'done',
      "echo STUB-OK",
      "exit 0",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  // same hermeticity as the failure-path test above (review r1 finding 5)
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_HOME: home,
    DSH_PERSISTENT_HOME: "1",
    STUB_ARGS_FILE: argsFile,
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.DSH_SESSION_PATH_FILE;
  delete env.DSH_MODEL;
  delete env.DSH_SUBAGENT_MODEL;
  // extraEnv LAST: the per-test overrides must survive the base scrub above.
  Object.assign(env, extraEnv);

  const proc = spawnSync("bash", [SCRIPT, "subagent model test task"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  const args = existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "";
  return { proc, dir, home, args };
};

test("DSH_SUBAGENT_MODEL stamps the overlay and passes --patch to dsh", () => {
  const { proc, home, args } = runLauncher({ DSH_SUBAGENT_MODEL: "zai/glm-5-turbo" });
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  assert.match(proc.stderr, /subagent model: zai\/glm-5-turbo \(subagent \+ subagent_fork/);
  // --patch rides between --profile headless and the task text
  const lines = args.split("\n").filter((l) => l !== "" && !l.startsWith("---") && !l.startsWith("#"));
  const patchAt = lines.indexOf("--patch");
  assert.ok(patchAt > 0, `dsh must receive --patch, got argv: ${lines.join(" ")}`);
  assert.equal(lines[patchAt - 1], "headless", "--patch follows --profile headless");
  assert.equal(lines[patchAt + 1], path.join(home, "subagent-model.patch.yml"));
  // The stamped overlay: BOTH dsh-tool-subagent instances, config restated
  // wholesale (provider/toolName/backgroundMode) + the agentOptions route.
  assert.match(args, /- id: tool-subagent\n/);
  assert.match(args, /- id: tool-subagent-fork\n/);
  for (const tool of ["subagent", "subagent_fork"]) {
    assert.match(
      args,
      new RegExp(
        `provider: ${tool === "subagent" ? "spawn" : "fork"}\\n` +
        `    toolName: ${tool}\\n` +
        `    backgroundMode: ${tool === "subagent" ? "continuable" : "one-shot"}\\n` +
        `    agentOptions:\\n` +
        `      provider: zai\\n` +
        `      model: glm-5-turbo`,
      ),
      `overlay must restate the whole config for ${tool} and override its route`,
    );
  }
});

test("DSH_SUBAGENT_MODEL unset launches dsh with NO --patch and no overlay (inherit = today's behavior)", () => {
  const { proc, home, args } = runLauncher({});
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  assert.ok(!args.includes("--patch"), `no --patch flag when unset, got argv: ${args}`);
  assert.ok(
    !existsSync(path.join(home, "subagent-model.patch.yml")),
    "no overlay file must be stamped when unset",
  );
});

test("DSH_SUBAGENT_MODEL without provider/model fails closed before any launch", () => {
  const { proc, args } = runLauncher({ DSH_SUBAGENT_MODEL: "glm-5-turbo" });
  assert.equal(proc.status, 2, "malformed override must exit 2");
  assert.match(proc.stderr, /DSH_SUBAGENT_MODEL must be provider\/model/);
  assert.equal(args, "", "dsh must never be launched on a malformed override");
});

test("the stamped overlay composes onto the real headless profile (skip when dsh is absent)", { skip: spawnSync("dsh", ["--version"]).status !== 0 }, () => {
  const { home } = runLauncher({ DSH_SUBAGENT_MODEL: "zai/glm-5-turbo" });
  const overlay = path.join(home, "subagent-model.patch.yml");
  assert.ok(existsSync(overlay), "overlay stamped");

  // Isolated real composition: fresh DSH_HOME (dsh scaffolds the profile),
  // so nothing touches this runner's own harness home.
  const isoHome = mkdtempSync(path.join(tmpdir(), "dsh-dump-home-"));
  const dumpEnv = { ...process.env, DSH_HOME: isoHome, PATH: process.env.PATH };
  delete dumpEnv.DSH_MODEL;
  delete dumpEnv.DSH_SUBAGENT_MODEL;
  try {
    const dump = spawnSync(
      "dsh",
      ["--profile", "headless", "--patch", overlay, "--dump-config"],
      { encoding: "utf8", env: dumpEnv, timeout: 60_000 },
    );
    assert.equal(dump.status, 0, `dump-config must compose, stderr: ${dump.stderr}`);
    for (const [id, provider, tool, mode] of [
      ["tool-subagent", "spawn", "subagent", "continuable"],
      ["tool-subagent-fork", "fork", "subagent_fork", "one-shot"],
    ]) {
      const row = new RegExp(
        `- id: ${id}\\n  name: '@deepseek-ai/dsh-tool-subagent'\\n  config:\\n` +
        `    provider: ${provider}\\n    toolName: ${tool}\\n    backgroundMode: ${mode}\\n` +
        `    agentOptions:\\n      provider: zai\\n      model: glm-5-turbo`,
      );
      assert.match(dump.stdout, row, `composed ${id} row must carry the turbo agentOptions`);
    }

    // Drift guard: the restated provider/toolName/backgroundMode must equal
    // the profile's own defaults (no --patch). If dsh-headless ever changes
    // them, this red run forces the stamp to move in the same commit.
    const def = spawnSync("dsh", ["--profile", "headless", "--dump-default-config"], {
      encoding: "utf8",
      env: dumpEnv,
      timeout: 60_000,
    });
    assert.equal(def.status, 0, `dump-default-config must run, stderr: ${def.stderr}`);
    for (const [id, provider, tool, mode] of [
      ["tool-subagent", "spawn", "subagent", "continuable"],
      ["tool-subagent-fork", "fork", "subagent_fork", "one-shot"],
    ]) {
      const row = new RegExp(
        `- id: ${id}\\n  name: '@deepseek-ai/dsh-tool-subagent'\\n  config:\\n` +
        `    provider: ${provider}\\n    toolName: ${tool}\\n    backgroundMode: ${mode}\\n`,
      );
      assert.match(
        def.stdout,
        row,
        `profile default for ${id} drifted from the stamp's restated values — update the stamp in run-dsh-agent.sh`,
      );
    }
  } finally {
    rmSync(isoHome, { recursive: true, force: true });
  }
});

// --- 8. DSH_SUBAGENT_MODEL validation is charset+shape, not slash-presence -
//
// The halves are interpolated into STRUCTURED YAML (the stamped overlay), so
// values that carry YAML metacharacters are injection vectors, not typos to
// be discovered at child spawn: a newline injects sibling agentOptions keys
// (`zai/glm-5.2\n    maxDepth: 99` stamps a maxDepth row — verified against
// the pre-fix launcher), a `#` comments the rest of a line away, a `:`
// reinterprets a scalar, a space splits a key. All of those PASS a
// slash-only check, which is why the script validates by deletion-residue
// (delete [A-Za-z0-9._-/], require empty) plus anchored shape cases. The
// literal glob-class alternative (`[A-Za-z0-9._-]*/…`) is itself leaky: in
// glob semantics the trailing `*` is an unbounded star, not a class
// quantifier, so `zai/glm:5.2` and the newline value still match it.
test("DSH_SUBAGENT_MODEL rejects YAML metacharacters and malformed shapes before anything is stamped", () => {
  const bad = [
    "zai/",                          // empty model half (shape)
    "/glm-5.2",                      // empty provider half (shape)
    "zai/glm-5.2\n    maxDepth: 99", // YAML sibling-key injection via newline (charset)
    "#zai/glm-5.2",                  // comment-shaped value (charset)
    "zai/glm:5.2",                   // mapping colon (charset)
    "zai/glm 5.2",                   // space (charset)
    "a/b/c",                         // two slashes (shape)
    ".zai/glm-5.2",                  // non-alnum provider start (shape)
  ];
  for (const value of bad) {
    const { proc, home, args } = runLauncher({ DSH_SUBAGENT_MODEL: value });
    assert.equal(proc.status, 2, `value ${JSON.stringify(value)} must be rejected with exit 2, stderr: ${proc.stderr}`);
    assert.match(
      proc.stderr,
      /error: DSH_SUBAGENT_MODEL/,
      `value ${JSON.stringify(value)} must fail with the typed error`,
    );
    assert.equal(args, "", `value ${JSON.stringify(value)} must never launch dsh`);
    assert.ok(
      !existsSync(path.join(home, "subagent-model.patch.yml")),
      `value ${JSON.stringify(value)} must not stamp an overlay`,
    );
  }
  // The shapes that MUST pass (the fleet's real values) — accepted, stamped.
  for (const good of ["zai/glm-5.2", "zai/glm-5-turbo", "opencode-go2/deepseek-v4-flash", "a/b"]) {
    const { proc, home } = runLauncher({ DSH_SUBAGENT_MODEL: good });
    assert.equal(proc.status, 0, `value ${JSON.stringify(good)} must be accepted, stderr: ${proc.stderr}`);
    assert.ok(
      existsSync(path.join(home, "subagent-model.patch.yml")),
      `value ${JSON.stringify(good)} must stamp its overlay`,
    );
  }
});

// --- 9. the stamped overlay BOOTS: the plugin tree loads (real dsh) -------
//
// --dump-config (test 4's composition check) validates NOTHING: it exits 0
// over a patch whose plugin tree cannot load — the review-run-32897389988
// defect class in the #24 lineage, where an agentOptions-only stamp was
// green to the dump while every real boot died with "plugin tree failed to
// load … $.provider missing required value". The only hermetic proof that
// the launcher's stamp is bootable is booting it: `dsh --profile headless
// --patch <overlay>` zod-validates every plugin config BEFORE any
// credential lookup, so with no API key in env it dies fast at credential
// resolution — and reaching that step IS the pass condition. Skipped when
// the dsh CLI is absent (lanes without it keep the stub-level coverage).
test("the stamped overlay boots: the real plugin tree loads against it (skip when dsh is absent)", { skip: spawnSync("dsh", ["--version"]).status !== 0 }, () => {
  const { home } = runLauncher({ DSH_SUBAGENT_MODEL: "zai/glm-5.2" });
  const overlay = path.join(home, "subagent-model.patch.yml");
  assert.ok(existsSync(overlay), "overlay stamped by the launcher run");
  assert.ok(existsSync(path.join(home, "settings.yaml")), "settings stamped by the same launcher run");

  const cwd = mkdtempSync(path.join(tmpdir(), "dsh-submodel-bootcwd-"));
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
    assert.doesNotMatch(
      combined,
      /plugin tree failed to load/,
      "the profile must LOAD against the stamped overlay — this signature is the dump-green/boot-dead defect class",
    );
    assert.doesNotMatch(
      combined,
      /\$\.provider missing required value/,
      "dsh-tool-subagent's zod schema must be satisfied: the restated base keys survived the patch",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 10. the HEAD stays on the settings model (real dsh boot) -------------
//
// The other half of the change's contract: the override routes ONLY the
// subagent/subagent_fork children — the head agent must ride the SETTINGS
// model (agent-default-model zai/glm-5.3 from the launcher's own
// settings.yaml stamp), never the override. Boot is the observable: with
// settings naming zai and the children overridden to a DIFFERENT provider
// (opencode-go2), credential resolution must name the SETTINGS route
// ("zai") — if the patch had leaked into the head's model, the error would
// name opencode-go2 instead. This is also the runtime proof that
// settings.yaml applies to the booted tree (a --dump-config cannot show
// it: it prints layer views without resolving them). Skipped when the dsh
// CLI is absent.
test("the head stays on the settings model: boot resolves the SETTINGS provider route, not the override (skip when dsh is absent)", { skip: spawnSync("dsh", ["--version"]).status !== 0 }, () => {
  // Children overridden to a provider DIFFERENT from settings' zai so the
  // two halves are distinguishable in the credential-resolution error.
  const { home } = runLauncher({ DSH_SUBAGENT_MODEL: "opencode-go2/deepseek-v4-flash" });
  const overlay = path.join(home, "subagent-model.patch.yml");
  assert.ok(existsSync(overlay), "overlay stamped by the launcher run");

  const cwd = mkdtempSync(path.join(tmpdir(), "dsh-submodel-maincwd-"));
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
    assert.match(combined, /MISSING_CREDENTIAL/, "the boot must reach credential resolution — proving settings.yaml applies at runtime");
    assert.match(
      combined,
      /provider route "zai"/,
      "the HEAD resolves its model from settings.yaml (zai/glm-5.3) — the run model, not the override",
    );
    assert.doesNotMatch(
      combined,
      /provider route "opencode-go2"/,
      "the subagent override must not become the head's route — that would be this half broken",
    );
    assert.doesNotMatch(combined, /plugin tree failed to load/, "the patched plugin tree must still load");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- 8-13. DSH_WEB_SEARCH_CELLS: mount the local key-free ctx.web provider
// (@local/dsh-web-search-browser, factory issue #293) on listed cells only.
// Contract: unset/empty = off EVERYWHERE (default-off rollout); a listed
// RUNNER_NAME gets (a) the cell's plugin copy re-performed into this job's
// profile module fallback and (b) a regenerated --patch overlay whose web/
// tool-web rows are whole-config RESTATEMENTS and whose provider row rides
// an explicit `insert:` list — a bare row with an unknown id only warns and
// is silently skipped by the loader's patch applier (the dead-patch trap).
// An unlisted runner gets a byte-identical launch line. A listed runner
// without a complete cell copy must FAIL LOUD, not dead-mount.

// A minimal but complete plugin copy (what a gate-provisioned cell holds:
// manifest + the entry module the loader imports). The module must be a
// VALID cordis plugin — a function or an object with an `apply` method —
// because the live boot test loads it with real dsh; a bare export object
// fails the real loader ("invalid plugin") while every string assertion
// still passes, which is the stub-proof/live-truth gap.
const makePluginCopy = (dir) => {
  const src = path.join(dir, "cell-plugin", "dsh-web-search-browser");
  mkdirSync(path.join(src, "lib"), { recursive: true });
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "@local/dsh-web-search-browser", version: "0.3.2", type: "module", main: "lib/index.js" }));
  writeFileSync(
    path.join(src, "lib", "index.js"),
    "export const name = 'web-search-browser';\nexport function apply() {}\nexport default { name, apply };\n",
  );
  return src;
};

const WEB_BASE = (pluginSrc) => ({
  DSH_WEB_SEARCH_CELLS: "mini-dsh,mini-dsh-2",
  RUNNER_NAME: "mini-dsh-2",
  DSH_WEB_SEARCH_BROWSER_PATH: pluginSrc,
});

test("DSH_WEB_SEARCH_CELLS mounts the provider on a listed runner: plugin copied, overlay stamped, second --patch passed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-web-mount-"));
  const { proc, home, args } = runLauncher(WEB_BASE(makePluginCopy(dir)));
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  assert.match(proc.stderr, /web-search-browser: mounted for this run/);
  // (a) the plugin copy rides THIS job's profile module fallback
  const copied = path.join(home, "profiles", "node_modules", "@local", "dsh-web-search-browser");
  assert.ok(existsSync(path.join(copied, "package.json")) && existsSync(path.join(copied, "lib", "index.js")),
    "the plugin must be copied into $DSH_HOME/profiles/node_modules/@local/");
  // (b) the overlay: restated rows + insert-listed provider row
  const overlay = path.join(home, "web-search-browser.patch.yml");
  assert.ok(existsSync(overlay), "web overlay stamped");
  const overlayText = readFileSync(overlay, "utf8");
  assert.match(overlayText, /- id: web\n  name: '@deepseek-ai\/dsh-web'\n  config:\n    searchProvider: headless-browser\n/);
  assert.match(overlayText, /- id: tool-web\n  name: '@deepseek-ai\/dsh-tool-web'\n  config:\n    fetch: true\n    searchTimeoutMs: 60000\n    fetchTimeoutMs: 60000\n/);
  assert.match(overlayText, /- insert:\n    - id: web-search-browser\n      name: '@local\/dsh-web-search-browser'\n/,
    "the provider row must ride an explicit insert list — a bare unknown-id row is silently skipped by the loader");
  assert.match(args, /web-search-browser\.patch\.yml/, "dsh must receive the web overlay path");
  // (c) both overlays ride the launch line when both features are active
  const withBoth = runLauncher({ ...WEB_BASE(makePluginCopy(dir)), DSH_SUBAGENT_MODEL: "zai/glm-5-turbo" });
  const bothArgs = readFileSync(path.join(withBoth.dir, "dsh-args.txt"), "utf8");
  assert.match(bothArgs, /subagent-model\.patch\.yml/);
  assert.match(bothArgs, /web-search-browser\.patch\.yml/);
  assert.equal(bothArgs.indexOf("subagent-model.patch.yml") < bothArgs.indexOf("web-search-browser.patch.yml"), true,
    "the subagent overlay precedes the web overlay (deterministic argv order)");
  rmSync(dir, { recursive: true, force: true });
});

test("DSH_WEB_SEARCH_CELLS without this runner's name stays off: no overlay, no copy, byte-identical default", () => {
  const { proc, home, args } = runLauncher({ DSH_WEB_SEARCH_CELLS: "some-other-cell", RUNNER_NAME: "mini-dsh-2" });
  assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
  assert.doesNotMatch(proc.stderr, /web-search-browser: mounted/);
  assert.ok(!existsSync(path.join(home, "web-search-browser.patch.yml")), "no web overlay stamped");
  assert.ok(!existsSync(path.join(home, "profiles", "node_modules", "@local")), "no plugin copy performed");
  assert.ok(!args.includes("--patch"), "launch line stays byte-identical");
  // glob matching is anchored at an entry level: an entry that merely CONTAINS
  // the runner name must not enable it
  const prefix = runLauncher({ DSH_WEB_SEARCH_CELLS: "mini-dsh-2.backup", RUNNER_NAME: "mini-dsh-2" });
  assert.ok(!existsSync(path.join(prefix.home, "web-search-browser.patch.yml")), "an entry containing the name is not a match");
  // an entry can be a machine-level GLOB covering the elastic pool spawned on the same hardware
  const gdir = mkdtempSync(path.join(tmpdir(), "dsh-web-glob-"));
  const globbed = runLauncher({ DSH_WEB_SEARCH_CELLS: "mini-dsh*", RUNNER_NAME: "mini-dsh-e13", DSH_WEB_SEARCH_BROWSER_PATH: makePluginCopy(gdir) });
  assert.ok(existsSync(path.join(globbed.home, "web-search-browser.patch.yml")), "a listed glob enables the elastic instance on that machine");
  rmSync(gdir, { recursive: true, force: true });
  const globMiss = runLauncher({ DSH_WEB_SEARCH_CELLS: "seed-*", RUNNER_NAME: "mini-dsh-e13" });
  assert.ok(!existsSync(path.join(globMiss.home, "web-search-browser.patch.yml")), "a non-matching glob stays off");
  // an unknown RUNNER_NAME (empty) must never enable
  const unnamed = runLauncher({ DSH_WEB_SEARCH_CELLS: "mini-dsh," });
  assert.ok(!existsSync(path.join(unnamed.home, "web-search-browser.patch.yml")), "no runner name = never enables");
});

test("a listed runner without a complete cell copy fails loud with the provisioning hint (no dead mounts)", () => {
  const { proc, home } = runLauncher({ DSH_WEB_SEARCH_CELLS: "mini-dsh-2", RUNNER_NAME: "mini-dsh-2" });
  assert.notEqual(proc.status, 0, "the launcher must fail loud, not dead-mount");
  assert.match(proc.stderr, /per-cell plugin copy is missing or incomplete/);
  assert.match(proc.stderr, /live smoke/, "the hint names the gate the cell must pass");
  assert.ok(!existsSync(path.join(home, "web-search-browser.patch.yml")), "no overlay stamped on failure");
});

test("persistent-home mode never bricks the cell: source IS the canonical copy, the mount leaves it intact (review r1 finding 1)", () => {
  // Provision $HOME/.dsh — the DEFAULT source root — with a complete copy,
  // then run the mount with NO DSH_WEB_SEARCH_BROWSER_PATH. Under
  // DSH_PERSISTENT_HOME=1 the home is $HOME/.dsh, so source and destination
  // are the same tree. Without the same-tree guard the mount's rm -rf
  // deletes the provisioned copy before cp reads it: run 1 exits 1 with a
  // bare `cp: cannot stat`, and every later run on that cell dies on
  // "per-cell plugin copy is missing or incomplete" until re-provisioned.
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-web-persist-"));
  const home = path.join(dir, ".dsh");
  const canonical = path.join(home, "profiles", "node_modules", "@local", "dsh-web-search-browser");
  mkdirSync(path.join(canonical, "lib"), { recursive: true });
  writeFileSync(path.join(canonical, "package.json"), JSON.stringify({ name: "@local/dsh-web-search-browser", version: "0.3.2", type: "module", main: "lib/index.js" }));
  writeFileSync(path.join(canonical, "lib", "index.js"), "export const name = 'web-search-browser';\n");
  const { proc } = runLauncher({
    DSH_WEB_SEARCH_CELLS: "mini-dsh-2",
    RUNNER_NAME: "mini-dsh-2",
    DSH_HOME: home,
    // HOME too: the default SOURCE root is $HOME/.dsh (persistent-home
    // default), and the harness's HOME must point at the same tree for
    // source and destination to actually collide.
    HOME: dir,
    // no DSH_WEB_SEARCH_BROWSER_PATH: the canonical default source applies
  });
  assert.equal(proc.status, 0, `the same-tree mount must succeed, stderr: ${proc.stderr}`);
  assert.ok(existsSync(path.join(canonical, "package.json")) && existsSync(path.join(canonical, "lib", "index.js")),
    "the provisioned canonical copy must survive the mount — deleting it bricks the cell");
  assert.match(proc.stderr, /same-tree guard/, "the skip must be visible, not silent");
  assert.ok(existsSync(path.join(home, "web-search-browser.patch.yml")), "the overlay still stamps — the mount is the overlay, not the copy");
  const overlayText = readFileSync(path.join(home, "web-search-browser.patch.yml"), "utf8");
  assert.match(overlayText, /- id: web\n  name: '@deepseek-ai\/dsh-web'\n  config:\n    searchProvider: headless-browser\n/);
  rmSync(dir, { recursive: true, force: true });
});

test("DSH_WEB_SEARCH_BROWSER_PATH relocates the canonical copy the mount is performed from", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-web-path-"));
  const { home } = runLauncher({ ...WEB_BASE(makePluginCopy(dir)), });
  assert.ok(existsSync(path.join(home, "profiles", "node_modules", "@local", "dsh-web-search-browser", "package.json")),
    "the relocation seam is honored");
  const gone = runLauncher({ ...WEB_BASE(path.join(dir, "missing")) });
  assert.notEqual(gone.proc.status, 0, "a missing relocated copy fails loud");
  rmSync(dir, { recursive: true, force: true });
});

test("DSH_WEB_SEARCH_BROWSER_BROWSERS pins the browser list into the overlay; metacharacters, spaced pins, and non-executable entries fail loud", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-web-pin-"));
  const base = WEB_BASE(makePluginCopy(dir));
  // A pinned entry is filesystem-validated (review r1 finding 2): it must
  // EXIST and be executable, so the green case pins a real stub binary —
  // not a path that merely happens to be charset-clean.
  const browserStub = path.join(dir, "bin", "chrome-headless-shell");
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(browserStub, "#!/bin/sh\nexit 0\n");
  chmodSync(browserStub, 0o755);
  const good = runLauncher({ ...base, DSH_WEB_SEARCH_BROWSER_BROWSERS: browserStub });
  assert.equal(good.proc.status, 0, `pinned run must succeed, stderr: ${good.proc.stderr}`);
  const overlayText = readFileSync(path.join(good.home, "web-search-browser.patch.yml"), "utf8");
  assert.ok(overlayText.includes(`browsers:\n          - ${browserStub}\n`),
    "the pin lands as a YAML list under the provider config");
  const plain = runLauncher(base);
  assert.ok(!readFileSync(path.join(plain.home, "web-search-browser.patch.yml"), "utf8").includes("browsers:"),
    "no browsers key without the pin (the provider auto-detects)");
  const evil = runLauncher({ ...base, DSH_WEB_SEARCH_BROWSER_BROWSERS: "/tmp/ok' - id: x" });
  assert.notEqual(evil.proc.status, 0, "YAML metacharacters in the pin must fail loud");
  assert.match(evil.proc.stderr, /plain paths of \[A-Za-z0-9\._\/@\+-\]/);
  // A space-containing pin splits at the whitespace separator BEFORE the
  // charset check sees it, and the split halves pass the charset — the
  // filesystem check is what catches them (they used to stamp two bogus
  // list items and exit 0: review r1 finding 2).
  const spaced = runLauncher({ ...base, DSH_WEB_SEARCH_BROWSER_BROWSERS: `${dir}/My Browser/chrome-headless-shell` });
  assert.notEqual(spaced.proc.status, 0, "a space-containing pin must fail loud, not stamp its split halves");
  assert.match(spaced.proc.stderr, /not an existing executable file/);
  // A charset-clean entry that does not exist fails the same check.
  const absent = runLauncher({ ...base, DSH_WEB_SEARCH_BROWSER_BROWSERS: "/nonexistent/chrome-headless-shell" });
  assert.notEqual(absent.proc.status, 0, "a pinned non-existent binary must fail loud");
  assert.match(absent.proc.stderr, /not an existing executable file/);
  rmSync(dir, { recursive: true, force: true });
});

// --- the web overlay boots: the insert-listed provider tree loads (real dsh,
// skip when the CLI is absent). Same pattern as the subagent overlay boots
// above: compose is not proof — `--dump-config` validates nothing, and the
// loader silently skips a bare row whose id is unknown (the dead-patch trap
// the insert grammar exists to prevent). Boot is the only hermetic proof:
// with no credentials in env the run must die at credential resolution —
// reaching that step proves the restated web/tool-web rows and the
// insert-listed @local provider tree all passed the real plugins' validation.
test("the stamped web overlay boots: the insert-listed provider tree loads (skip when dsh is absent)", { skip: spawnSync("dsh", ["--version"]).status !== 0 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-web-boot-"));
  const { home } = runLauncher(WEB_BASE(makePluginCopy(dir)));
  const overlay = path.join(home, "web-search-browser.patch.yml");
  assert.ok(existsSync(overlay), "web overlay stamped by the launcher run");

  const cwd = mkdtempSync(path.join(tmpdir(), "dsh-web-bootcwd-"));
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
    assert.doesNotMatch(
      combined,
      /plugin tree failed to load/,
      "the insert-listed @local provider tree must load — an insert row that fails to resolve is the dead-mount class",
    );
    assert.match(
      combined,
      /MISSING_CREDENTIAL/,
      "the boot must reach credential resolution — proving the restated web/tool-web rows and the provider row compose",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
