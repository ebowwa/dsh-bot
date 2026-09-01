// local-fleet-audit.test.mjs — tests for scripts/local-fleet-audit.sh.
//
// The air-native-linux incident (2026-08-31 → 09-01): a laptop LaunchAgent
// claimed tower lane tickets for ~30 hours while every cloud-side audit
// was green. The perimeter rule these tests pin: an occupancy audit
// covers the LOCAL plane — processes, service managers, filesystem
// artifacts — and the audit itself must catch planted participants.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = path.join(ROOT, "scripts", "local-fleet-audit.sh");

const fixture = (plant = true) => {
  const dir = mkdtempSync(path.join(tmpdir(), "local-audit-test-"));
  const home = path.join(dir, "home");
  const shim = path.join(dir, "shim");
  mkdirSync(home, { recursive: true });
  mkdirSync(shim, { recursive: true });
  if (plant) {
    // a rogue install dir + workdir + an active plist
    mkdirSync(path.join(home, "dsh-node-air"));
    mkdirSync(path.join(home, "dsh-node-workdir-air"));
    mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path.join(home, "Library", "LaunchAgents", "sh.dsh.node.air-linux.plist"), "x");
  }
  // stub launchctl + ps: report dsh participants when planted (the plant
  // must be observable on EVERY plane the audit checks)
  writeFileSync(path.join(shim, "launchctl"), `#!/usr/bin/env bash
if [ "$1" = "list" ]; then
  ${plant ? 'echo "999\t0\tcom.dsh.rogue"' : ""}
  exit 0
fi
exit 0
`);
  writeFileSync(path.join(shim, "ps"), `#!/usr/bin/env bash
${plant ? 'echo "user 999 0.0 0.0 /usr/local/bin/dsh-node --lane linux"' : 'echo "user 1 0.0 0.0 /sbin/launchd"'}
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "launchctl")]);
  spawnSync("chmod", ["+x", path.join(shim, "ps")]);
  return { dir, home,
    env: { ...process.env, HOME: home, PATH: `${shim}${path.delimiter}${process.env.PATH}` } };
};

test("detects planted participants loudly (processes, launchd, dirs, plists)", () => {
  const f = fixture(true);
  try {
    const res = spawnSync("bash", [AUDIT], { encoding: "utf8", env: f.env });
    assert.equal(res.status, 0, "report-only: always exit 0");
    const out = res.stdout + res.stderr;
    assert.match(out, /FINDING: live participant processes/);
    assert.match(out, /FINDING: launchd services/);
    assert.match(out, /directory: .*dsh-node-air/);
    assert.match(out, /directory: .*dsh-node-workdir-air/);
    assert.match(out, /LaunchAgent plist: .*air-linux\.plist/);
    assert.match(out, /RESULT: [1-9][0-9]* finding/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a clean machine reports clean", () => {
  const f = fixture(false);
  try {
    const res = spawnSync("bash", [AUDIT], { encoding: "utf8", env: f.env });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /RESULT: clean/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a sanctioned worker install is reported WITH its keepalive context", () => {
  const f = fixture(false);
  try {
    mkdirSync(path.join(f.home, ".dsh-worker"), { recursive: true });
    writeFileSync(path.join(f.home, ".dsh-worker", "env"), "GH_TOKEN=x\n");
    writeFileSync(path.join(f.home, ".dsh-worker", "sweep.lock"), "");
    const res = spawnSync("bash", [AUDIT], { encoding: "utf8", env: f.env });
    assert.match(res.stdout, /this machine IS a worker/);
    assert.match(res.stdout, /sweeps have run here/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
