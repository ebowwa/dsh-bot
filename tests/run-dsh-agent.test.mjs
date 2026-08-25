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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
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
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_KEEP_SESSIONS: "", // default path: transcripts must be cleaned
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
