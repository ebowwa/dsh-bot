// worker-worktree.test.mjs — the shared-store worktree isolation, for real.
// A local bare origin (via the DSH_WORKER_ORIGIN_PREFIX seam) proves: one
// mirror store per repo, worktrees check out AT the requested ref with no
// per-item clone, stale worktree metadata prunes, and an unreachable
// origin fails loudly (no fake store).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

const extractFns = () => {
  const s = readFileSync(WORKER, "utf8");
  const grab = (name) => {
    const start = s.indexOf(`${name}() {`);
    assert.ok(start !== -1, "function missing: " + name);
    let depth = 0, i = start;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      if (s[i] === "}") { depth--; if (depth === 0) break; }
    }
    return s.slice(start, i + 1);
  };
  return ["git_auth_header", "git_clone", "repo_store", "git_wt", "wt_prune"].map(grab).join("\n\n") + "\n";
};

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-test-"));
  // macOS dev boxes have no flock (the Linux worker box does); a
  // pass-through stub is safe in single-threaded tests
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "flock"),
    "#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do case \"$1\" in [0-9]) shift; [ $# -gt 0 ] && exec \"$@\"; exit 0;; *) shift;; esac; done\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "flock")]);

  // origin layout mirrors the seam contract: PREFIX<owner/repo>.git
  const origins = path.join(dir, "origins");
  const origin = path.join(origins, "test", "repo.git");
  mkdirSync(path.dirname(origin), { recursive: true });
  const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  sh(`git init -q --bare "${origin}"`);
  const seed = path.join(dir, "seed");
  mkdirSync(seed);
  sh(`git init -q . && git config user.email t@t && git config user.name t && ` +
     `echo one > f.txt && git add . && git commit -qm one && git branch base && ` +
     `echo two >> f.txt && git commit -qam two && ` +
     `git push -q "${origin}" HEAD:main HEAD:base`, seed);

  const envPath = `${shim}${path.delimiter}${process.env.PATH}`;
  const runFns = (cmd) => {
    const script = path.join(dir, "fns.sh");
    const prologue = [
      "set -euo pipefail",
      `DATA=${JSON.stringify(path.join(dir, "data"))}`,
      "GH_TOKEN=stub-token",
      `DSH_BOT_DIR=${JSON.stringify(ROOT)}`,
      `ORIGIN_PREFIX=${JSON.stringify(origins + "/")}`,
    ].join("\n");
    writeFileSync(script, prologue + "\n" + extractFns() + cmd);
    return spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: envPath } });
  };
  return { dir, origins, sh, runFns };
};

test("one mirror store; worktrees check out AT the requested ref (no per-item clone)", () => {
  const f = fixture();
  try {
    const r1 = f.runFns(`git_wt test/repo "${f.dir}/wt1" refs/heads/main && git_wt test/repo "${f.dir}/wt2" refs/heads/base && echo OK`);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(path.join(f.dir, "wt1", "f.txt")), "worktree 1 checked out");
    assert.match(readFileSync(path.join(f.dir, "wt1", "f.txt"), "utf8"), /two/);
    assert.match(readFileSync(path.join(f.dir, "wt2", "f.txt"), "utf8"), /one/, "worktree 2 at the requested ref");
    const store = path.join(f.dir, "data", "repos", "test-repo.git");
    assert.ok(existsSync(store), "ONE shared mirror store");
    const ls = f.sh(`git --git-dir="${store}" worktree list`).stdout;
    assert.match(ls, /wt1/);
    assert.match(ls, /wt2/);
    rmSync(path.join(f.dir, "wt1"), { recursive: true, force: true });
    const r2 = f.runFns("wt_prune");
    assert.equal(r2.status, 0, r2.stderr);
    const ls2 = f.sh(`git --git-dir="${store}" worktree list`).stdout;
    assert.ok(!ls2.includes("wt1"), "pruned");
    assert.match(ls2, /wt2/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("unreachable origin fails loudly (no fake store, silent success)", () => {
  const f = fixture();
  try {
    const r = f.runFns(`ORIGIN_PREFIX="${f.dir}/nowhere/" git_wt test/repo "${f.dir}/wt3" HEAD`);
    assert.notEqual(r.status, 0, "an unreachable origin must fail loudly");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
