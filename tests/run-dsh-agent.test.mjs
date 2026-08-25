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

// --- 4. DSH_SUBAGENT_MODEL: the home-level patch that routes children ---

// Extracted-function runner: bash -euo pipefail with DSH_HOME/DSH_SUBAGENT_MODEL
// from a case table entry. Returns {status, stderr, patch}.
const runPatchFn = ({ home, value }) => {
  mkdirSync(home, { recursive: true });
  const fn = extractFunction("write_subagent_model_patch");
  const proc = spawnSync(
    "bash",
    ["-euo", "pipefail", "-c", `${fn}\nEFFECTIVE_MODEL=zai/glm-5.3\nwrite_subagent_model_patch`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DSH_HOME: home,
        ...(value === undefined ? {} : { DSH_SUBAGENT_MODEL: value }),
      },
    },
  );
  const patchPath = path.join(home, "cordis.patch.yml");
  return {
    status: proc.status,
    stderr: proc.stderr,
    patch: existsSync(patchPath) ? readFileSync(patchPath, "utf8") : null,
  };
};

test("DSH_SUBAGENT_MODEL unset writes no patch (children inherit — byte-identical default)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-unset-"));
  const out = runPatchFn({ home: dir, value: undefined });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out.status, 0, `unset must be a clean no-op, stderr: ${out.stderr}`);
  assert.equal(out.patch, null, "no cordis.patch.yml may exist when the env is unset");
});

test("DSH_SUBAGENT_MODEL=zai/glm-5.2 patches BOTH tool-subagent instances", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-write-"));
  const out = runPatchFn({ home: dir, value: "zai/glm-5.2" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out.status, 0, `valid value must succeed, stderr: ${out.stderr}`);
  assert.match(out.stderr, /subagent model: zai\/glm-5\.2 .*main stays zai\/glm-5\.3/);
  assert.match(out.patch, /id: tool-subagent$/m, "spawn instance (the subagent tool) overridden");
  assert.match(out.patch, /id: tool-subagent-fork$/m, "fork instance (subagent_fork) overridden");
  assert.match(out.patch, /provider: zai\n {6}model: glm-5\.2/, "agentOptions carry the split ids");
  assert.equal(out.patch.match(/model: glm-5\.2/g).length, 2, "exactly two overrides, one per instance");
  // A patch entry REPLACES the config map per id (no deep-merge): the base
  // keys MUST be carried through or dsh-tool-subagent's zod schema rejects
  // the tree at boot ($.provider missing required value — review run
  // 32897389988 finding 1). Assert them per instance, verbatim.
  assert.match(
    out.patch,
    /- id: tool-subagent\n  config:\n    provider: spawn\n    toolName: subagent\n    backgroundMode: continuable\n    agentOptions:/,
    "the spawn instance must keep its base keys alongside agentOptions",
  );
  assert.match(
    out.patch,
    /- id: tool-subagent-fork\n  config:\n    provider: fork\n    toolName: subagent_fork\n    backgroundMode: one-shot\n    agentOptions:/,
    "the fork instance must keep its base keys alongside agentOptions",
  );
});

test("DSH_SUBAGENT_MODEL without a provider/model slash fails loud (exit 2, no file)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-bad-"));
  const out = runPatchFn({ home: dir, value: "glm-5.2" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out.status, 2, "malformed value must abort the run, not silently inherit");
  assert.match(out.stderr, /DSH_SUBAGENT_MODEL must be provider\/model/);
  assert.equal(out.patch, null);
});

test("DSH_SUBAGENT_MODEL rejects empty halves and YAML metacharacters (charset, not slash-presence)", () => {
  // The value becomes STRUCTURED YAML — a newline could inject sibling keys,
  // a `#` comments the overlay out, a `:` reinterprets a scalar. Each entry
  // must fail loud BEFORE any file is written. Note `zai/glm:5.2` and the
  // newline entry also defeat the naive glob fix ([A-Za-z0-9._-]* — its
  // trailing * is an unbounded star, NOT a class quantifier), which is why
  // the script validates by deletion-residue.
  const bad = [
    "zai/",                                  // empty model
    "/glm-5.2",                              // empty provider
    "zai/glm-5.2\n    maxDepth: 99",         // YAML key injection via newline
    "#zai/glm-5.2",                          // comment-shaped value
    "zai/glm:5.2",                           // mapping colon
    "zai/glm 5.2",                           // space
    "a/b/c",                                 // two slashes
    ".zai/glm-5.2",                          // non-alnum provider start
  ];
  for (const value of bad) {
    const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-charset-"));
    const out = runPatchFn({ home: dir, value });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(out.status, 2, `value ${JSON.stringify(value)} must be rejected`);
    assert.match(out.stderr, /error: DSH_SUBAGENT_MODEL/, `value ${JSON.stringify(value)} must fail with the typed error`);
    assert.equal(out.patch, null, `value ${JSON.stringify(value)} must not write a file`);
  }
  // And the shapes that MUST pass (the fleet's real values):
  for (const good of ["zai/glm-5.2", "zai/glm-5.3", "opencode-go2/deepseek-v4-flash", "a/b"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-goodset-"));
    const out = runPatchFn({ home: dir, value: good });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(out.status, 0, `value ${JSON.stringify(good)} must be accepted, stderr: ${out.stderr}`);
    assert.ok(out.patch && out.patch.includes(`model: ${good.split("/")[1]}`), `value ${JSON.stringify(good)} must write the patch`);
  }
});

test("a hand-placed cordis.patch.yml is refused, never clobbered", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-clobber-"));
  const existing = "# operator overlay\n- id: tool-bash\n  disabled: true\n";
  writeFileSync(path.join(dir, "cordis.patch.yml"), existing);
  const out = runPatchFn({ home: dir, value: "zai/glm-5.2" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out.status, 2, "clobbering an operator's overlay must abort, not overwrite");
  assert.match(out.stderr, /refusing to clobber/);
  assert.equal(out.patch, existing, "the hand-placed overlay must be byte-identical after the refusal");
});

test("the full launcher puts the patch in place BEFORE dsh starts (call-site ordering)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-e2e-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  // dsh stub: prints the patch the agent would compose against — if the
  // call site ran after launch, the cat fails and this test goes red.
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      'echo "PATCH-BEGIN"; cat "${DSH_HOME}/cordis.patch.yml" || echo "NO-PATCH-FILE"; echo "PATCH-END"',
      "echo STUB-FINAL-ANSWER",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift; shift; shift\nexec \"$@\"\n");
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_SUBAGENT_MODEL: "zai/glm-5.2",
    DSH_KEEP_SESSIONS: "",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.DSH_HOME;
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;

  const proc = spawnSync("bash", [SCRIPT, "integration test task"], { encoding: "utf8", env, timeout: 60_000 });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(proc.status, 0, `launcher must succeed with the override set, stderr tail: ${proc.stderr.slice(-400)}`);
  assert.match(proc.stderr, /subagent model: zai\/glm-5\.2/, "the override is logged next to the run model");
  assert.match(proc.stdout, /PATCH-BEGIN[\s\S]*id: tool-subagent-fork[\s\S]*PATCH-END/, "the patch file existed when the agent launched");
});

test("the per-run patch is removed after the run on a persistent/explicit home (works more than once per home)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-submodel-cleanup-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      "echo STUB-FINAL-ANSWER",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift; shift; shift\nexec \"$@\"\n");
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) spawnSync("chmod", ["+x", path.join(bin, f)]);

  // An EXPLICIT DSH_HOME survives the run (never rm -rf'd — see the
  // JOB_SCOPED_HOME contract). Before the fix, the patch survived with it
  // and composed into EVERY later run against that home (file presence is
  // the only trigger), silently at first, then as a clobber-refusal exit 2
  // on the next explicit override — the input worked exactly once per home.
  const home = path.join(dir, "home");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    DSH_HOME: home,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_SUBAGENT_MODEL: "zai/glm-5.2",
    DSH_KEEP_SESSIONS: "",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.DSH_PERSISTENT_HOME;
  delete env.DSH_SESSION_PATH_FILE;

  const run1 = spawnSync("bash", [SCRIPT, "integration test task"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(run1.status, 0, `first run must succeed, stderr tail: ${run1.stderr.slice(-400)}`);
  assert.ok(existsSync(home), "an explicit home is never removed by the launcher");
  assert.ok(
    !existsSync(path.join(home, "cordis.patch.yml")),
    "the per-run patch must not outlive the run on a persistent/explicit home (stale-model leak, review finding 3)",
  );

  // The second explicit override against the same home must NOT trip the
  // clobber guard on our own residue.
  const run2 = spawnSync("bash", [SCRIPT, "integration test task 2"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(run2.status, 0, `second run with the input set must succeed (was: clobber-refusal exit 2), stderr tail: ${run2.stderr.slice(-400)}`);
  assert.ok(!existsSync(path.join(home, "cordis.patch.yml")), "no residue after the second run either");

  rmSync(dir, { recursive: true, force: true });
});

// --- 5. the composed config REALLY routes children (real dsh, no stub) --
//
// The launcher's contract is not "a file exists" but "dsh composes it":
// both tool-subagent instances must actually carry agentOptions after the
// home-level patch. This guards TWO couplings — the plugin ids (if a dsh
// release renames tool-subagent/tool-subagent-fork, the override silently
// stops applying) and the base config keys the patch must carry through
// (patch entries REPLACE the config map per id; if a release changes
// provider/toolName/backgroundMode, the boot test below goes red). The
// dump alone validates NOTHING — section 6 boots the real CLI. Skipped
// when the dsh CLI is absent (such lanes keep the function-level
// coverage above).
test("dsh composes the patch: both tool-subagent instances carry the turbo agentOptions", () => {
  const dshBin = spawnSync("bash", ["-c", "command -v dsh"], { encoding: "utf8" }).stdout?.trim();
  if (!dshBin) return; // tolerate lanes without the CLI

  const home = mkdtempSync(path.join(tmpdir(), "dsh-submodel-compose-"));
  const out = runPatchFn({ home, value: "zai/glm-5.2" });
  assert.equal(out.status, 0, `patch write failed: ${out.stderr}`);

  // A FRESH temp home carrying only cordis.patch.yml: the profile
  // auto-initializes from shipped templates (base/headless bundles
  // resolve from the dsh installation — no network, no npm install).
  const probeHome = mkdtempSync(path.join(tmpdir(), "dsh-submodel-probe-"));
  spawnSync("cp", [path.join(home, "cordis.patch.yml"), path.join(probeHome, "cordis.patch.yml")]);
  const cwd = mkdtempSync(path.join(tmpdir(), "dsh-submodel-cwd-"));
  const probe = spawnSync(dshBin, ["--profile", "headless", "--dump-config"], {
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    env: { ...process.env, DSH_HOME: probeHome },
  });
  rmSync(home, { recursive: true, force: true });
  rmSync(probeHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });

  assert.equal(probe.status, 0, `dsh --dump-config failed: ${probe.stderr.slice(-300)}`);
  // The dump prints EVERY layer's view (the patched composition on top of
  // the base layer), so occurrence counting is ambiguous; what pins the
  // contract is the exact composed BLOCK per instance — including the BASE
  // keys, because a patch entry with the same id REPLACES the config map
  // rather than merging into it. An agentOptions-only block here is the
  // review-run-32897389988 finding-1 defect: green to --dump-config (it
  // validates nothing) while the real boot dies with "$.provider missing
  // required value". These three lines are what would have gone red.
  assert.match(
    probe.stdout,
    /patched by [^\n]*dsh-submodel-probe-[^\n]*cordis\.patch\.yml/,
    "the composed tree must attribute a layer to our patch file",
  );
  const composedBlock = (toolId, provider, toolName, backgroundMode) =>
    new RegExp(
      `- id: ${toolId}\n` +
      "  name: '@deepseek-ai/dsh-tool-subagent'\\n" +
      "  config:\\n" +
      `    provider: ${provider}\\n` +
      `    toolName: ${toolName}\\n` +
      `    backgroundMode: ${backgroundMode}\\n` +
      "    agentOptions:\\n" +
      "      provider: zai\\n" +
      "      model: glm-5\\.2",
    );
  assert.match(probe.stdout, composedBlock("tool-subagent", "spawn", "subagent", "continuable"), "the subagent (spawn) instance must carry its base keys AND the turbo agentOptions");
  assert.match(probe.stdout, composedBlock("tool-subagent-fork", "fork", "subagent_fork", "one-shot"), "the subagent_fork (fork) instance must carry its base keys AND the turbo agentOptions");
});

// --- 6. the composed tree LOADS: boot the real CLI against the patch -----
//
// --dump-config validates NOTHING (review finding 2: it exits 0 over a
// patch whose plugin tree cannot load). The only hermetic proof that the
// generated overlay is bootable is booting it: `dsh --profile headless`
// loads and zod-validates every plugin config BEFORE any credential
// lookup, so with no API key in env it dies fast at credential resolution
// — and that is the pass condition: the failure signature of finding 1
// ("plugin tree failed to load … $.provider missing required value") must
// NOT appear. Skipped when the dsh CLI is absent.
test("the composed plugin tree actually loads: dsh boots against the generated patch (review finding 1)", () => {
  const dshBin = spawnSync("bash", ["-c", "command -v dsh"], { encoding: "utf8" }).stdout?.trim();
  if (!dshBin) return; // tolerate lanes without the CLI

  const home = mkdtempSync(path.join(tmpdir(), "dsh-submodel-boot-"));
  const out = runPatchFn({ home, value: "zai/glm-5.2" });
  assert.equal(out.status, 0, `patch write failed: ${out.stderr}`);

  const cwd = mkdtempSync(path.join(tmpdir(), "dsh-submodel-bootcwd-"));
  // Strip every plausible inference credential: the run must die at
  // credential resolution (fast, offline), never place a live call.
  const env = { ...process.env, DSH_HOME: home };
  for (const k of ["ZAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DOPPLER_SERVICE_TOKEN"]) delete env[k];
  const boot = spawnSync(dshBin, ["--profile", "headless", "reply ok"], {
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    env,
  });
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });

  assert.notEqual(boot.status, null, "the boot probe must terminate, not hang");
  const combined = `${boot.stdout}\n${boot.stderr}`;
  assert.doesNotMatch(
    combined,
    /plugin tree failed to load/,
    "the profile must LOAD against the patch the launcher writes — this signature is exactly the finding-1 defect (every run with the input set died before the first tool call)",
  );
  assert.doesNotMatch(
    combined,
    /\$\.provider missing required value/,
    "dsh-tool-subagent's zod schema must be satisfied: base keys survived the patch",
  );
});
