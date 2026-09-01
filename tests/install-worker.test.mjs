// install-worker.test.mjs — hermetic tests for scripts/install-worker.sh.
//
// The deploy workflow runs this ON a factory box; these tests pin the
// deployment's security shape offline: the env file is 0600 and holds the
// values, the cron line contains NO credential, installation is
// idempotent (no duplicate cron lines), and missing env fails typed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "scripts", "install-worker.sh");
const GH_CRED = "ghp_INSTALLERTESTTOKEN1234567890";
const DOPPLER_CRED = "dp.st.installertest.prj.slugvalue";

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "install-worker-test-"));
  const home = path.join(dir, "home");
  const botDir = path.join(dir, "toolkit");
  const shim = path.join(dir, "shim");
  const crontabLog = path.join(dir, "crontab-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(shim, { recursive: true });
  // toolkit dir pre-seeded with .git so the installer skips the clone
  // (offline: no network in this suite)
  mkdirSync(path.join(botDir, ".git"), { recursive: true });
  // stub crontab: records installs so idempotence is observable
  const store = path.join(dir, "crontab-store");
  writeFileSync(store, "");
  writeFileSync(path.join(shim, "crontab"), `#!/usr/bin/env bash
echo "crontab $*" >> "${crontabLog}"
if [ "$1" = "-l" ]; then cat "${store}"; exit 0; fi
cat > "${store}"
`);
  chmodSync(path.join(shim, "crontab"), 0o755);
  const flockLog = path.join(dir, "flock-calls.log");
  writeFileSync(path.join(shim, "flock"), `#!/usr/bin/env bash
echo "flock $*" >> "${flockLog}"
exit 0
`);
  chmodSync(path.join(shim, "flock"), 0o755);
  const gitLog = path.join(dir, "git-calls.log");
  writeFileSync(path.join(shim, "git"), `#!/usr/bin/env bash
echo "git $*" >> "${gitLog}"
exit 0
`);
  chmodSync(path.join(shim, "git"), 0o755);
  return { dir, home, botDir, store, crontabLog, gitLog, flockLog,
    env: (extra = {}) => ({
      HOME: home,
      WORKER_GH_CRED: GH_CRED,
      WORKER_DOPPLER_CRED: DOPPLER_CRED,
      WORKER_REPOS: "ebowwa/dsh-bot ebowwa/github-activity-tracker",
      DSH_BOT_INSTALL_DIR: botDir,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

test("installs the env file 0600 with the values; cron line has NO credential", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);

    const envFile = path.join(f.home, ".dsh-worker", "env");
    assert.ok(existsSync(envFile), "env file written");
    const mode = statSync(envFile).mode & 0o777;
    assert.equal(mode, 0o600, `env file mode must be 600 (got ${mode.toString(8)})`);
    const envBody = readFileSync(envFile, "utf8");
    assert.ok(envBody.includes(GH_CRED), "env holds the GH credential");
    assert.ok(envBody.includes(DOPPLER_CRED), "env holds the doppler credential");
    assert.match(envBody, /DSH_WORKER_REPOS="ebowwa\/dsh-bot ebowwa\/github-activity-tracker"/);

    const cron = readFileSync(f.store, "utf8");
    assert.match(cron, /dsh-worker\.sh --once/, "keepalive line installed");
    // flock, never pgrep: EVERY pgrep form self-matches (the carrier's
    // cmdline contains the real script path in the sweep braces — proven
    // live twice). flock is the canonical cron mutual exclusion.
    assert.match(cron, /flock -n .*sweep\.lock/, "flock-overlapped, no pgrep self-match possible");
    assert.ok(!cron.includes("pgrep"), "no pgrep guard may ship in the keepalive");
    assert.match(cron, /checkout -q v1/, "re-pins to the moving v1 tag each sweep");
    assert.match(cron, /fetch --tags --force/, "force-moves the moving tag (plain fetch clobbers: \"would clobber existing tag\")");
    assert.ok(!cron.includes(GH_CRED), "NO credential in the cron line");
    assert.ok(!cron.includes(DOPPLER_CRED), "NO doppler credential in the cron line");
    // the installer's own output never echoes the values either
    assert.ok(!res.stdout.includes(GH_CRED) && !res.stderr.includes(GH_CRED), "installer output is credential-free");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("idempotent: a second run does not duplicate the cron line", () => {
  const f = fixture();
  try {
    spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    const first = readFileSync(f.store, "utf8");
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /canonical line enforced/, "second run re-enforces the canonical line");
    const second = readFileSync(f.store, "utf8");
    assert.equal(second, first, "crontab unchanged by the second run");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("always refreshes the toolkit pin to v1 (with safe.directory; no silent failures)", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /toolkit pinned at/);
    const git = readFileSync(f.gitLog, "utf8");
    assert.match(git, /fetch --tags/, "fetches tags every install");
    assert.match(git, /checkout v1/, "checks out the moving v1 pin");
    assert.match(git, /safe\.directory=/, "ownership guard explicitly satisfied");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing credentials fail typed (exit 2), nothing written", () => {
  const f = fixture();
  try {
    const env = f.env({ WORKER_GH_CRED: "" });
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /WORKER_GH_CRED unset/);
    assert.ok(!existsSync(path.join(f.home, ".dsh-worker")), "no env dir on failure");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});