// driver-token-guard.test.mjs — the typed DOPPLER_SERVICE_TOKEN guard in
// run-dsh-agent.sh (PR #45 review finding 4).
//
// The agent launches only via `doppler run --token "$DOPPLER_SERVICE_TOKEN"`
// and there is no local-auth fallback. Before this guard, an unset token
// died at the launch line with a bare "unbound variable" AFTER installing
// dsh and probing cell tools; the env example even documented the token as
// optional — so a worker deployed per that example could never complete a
// task. The guard must be an EARLY, typed, cheap failure (exit 2) that runs
// before any tooling install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

test("driver without DOPPLER_SERVICE_TOKEN fails typed (exit 2) before any work", () => {
  const env = { ...process.env };
  delete env.DOPPLER_SERVICE_TOKEN;
  // Deliberately bare: the guard must fire before dsh install / cell-tool
  // probes, so no node/dsh/doppler availability is required here.
  const res = spawnSync("bash", [DRIVER, "some task"], {
    encoding: "utf8", env, timeout: 60_000,
  });
  assert.equal(res.status, 2, `expected typed exit 2 (got ${res.status})`);
  assert.match(res.stderr, /DOPPLER_SERVICE_TOKEN unset/);
  assert.ok(!res.stdout.includes("installing"), "guard must run BEFORE tooling install");
});

// The token-set path is pinned structurally in decouple-structure.test.mjs
// (F4) — spawning the full driver with a token would leave the hermetic
// regime (cell-tool probes, doppler, dsh install), which the offline suite
// must never do.