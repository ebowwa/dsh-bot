// post-reply.test.mjs — hermetic tests for scripts/post-reply.sh, the
// thread reply shared by the legacy workflow AND the decoupled worker.
// No network: a `gh` shim (PATH-prepended) logs the calls and the composed
// reply file is asserted. The reply surface is fail-closed SCRUBBED: a
// planted credential in the agent output must come out [redacted] and
// NEVER reach the composed reply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POST_REPLY = path.join(ROOT, "scripts", "post-reply.sh");
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "post-reply-test-"));
  const cache = path.join(dir, "cache");
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(cache, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });

  const ghLog = path.join(logs, "gh.log");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  return { dir, cache, ghLog,
    env: (extra = {}) => ({
      GH_TOKEN: "fake-token", DSH_SHIP_REPO: "owner/repo",
      TARGET_KIND: "issue", TARGET_NUM: "42", DSH_BOT_DIR: ROOT,
      DSH_SHIP_CACHE: cache, DSH_AGENT_OUTPUT: path.join(cache, "dsh-agent-output.txt"),
      DSH_SHIP_NOTE: "shipped [branch](https://github.com/owner/repo/pull/999)",
      DSH_RUN_ID: "run123", DSH_RUNNER_NAME: "worker-t", DSH_REPLY_OUT: path.join(cache, "reply.md"),
      GH_LOG: ghLog, PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

test("with ACK_COMMENT_ID the reply PATCHes the ack comment in place", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"),
      `finished. token ${TOKEN} is real\n`);
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8", env: f.env({ ACK_COMMENT_ID: "123" }),
    });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /comments\/123/);
    assert.match(log, /PATCH/);
    const reply = readFileSync(path.join(f.cache, "reply.md"), "utf8");
    assert.match(reply, /dsh agent \(GLM-5\.3\)/);
    assert.match(reply, /run: run123 /);
    assert.match(reply, /finished/);
    assert.match(reply, /\[redacted:token\]/);
    assert.ok(!reply.includes(TOKEN), "credential must never reach the composed reply");
    assert.match(reply, /Shipped.*pull\/999/s);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("without ACK_COMMENT_ID on a PR thread it posts a fresh PR comment", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    writeFileSync(path.join(f.cache, "dsh-ship-note.txt"), "shipped [b](https://github.com/owner/repo/pull/1)");
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8",
      env: f.env({ TARGET_KIND: "pr", TARGET_NUM: "7", DSH_SHIP_NOTE: "" }),
    });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /pr comment 7/);
    assert.match(log, /--body-file/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("requires TARGET_KIND and DSH_SHIP_REPO (fails loudly, never posts blind)", () => {
  const f = fixture();
  try {
    const env = f.env({ TARGET_KIND: "" });
    delete env.TARGET_KIND;
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /TARGET_KIND/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});