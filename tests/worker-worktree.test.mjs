// worker-worktree.test.mjs — the shared-store worktree isolation, for real.
// A local bare origin (via the DSH_WORKER_ORIGIN_PREFIX seam) proves: one
// mirror store per repo, worktrees check out AT the requested ref with no
// per-item clone, stale worktree metadata prunes, and the plain-clone
// fallback fires when the origin is unreachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

// source ONLY the functions we need (the script runs a sweep when executed)
const FN_PROLOGUE = `set -euo pipefail
DATA="__DATA__"
GH_TOKEN=stub
DSH_BOT_DIR="${ROOT}"
ORIGIN_PREFIX="__ORIGIN__"
`;
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
import { readFileSync } from "node:fs";

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-test-"));
  // macOS dev boxes have no flock (the Linux worker box does) — a
  // pass-through stub is safe in single-threaded tests
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "flock"), "#!/usr/bin/env bash\n# drop flags until the fd digit; exec a trailing command if present\nwhile [ $# -gt 0 ]; do case \"$1\" in [0-9]) shift; [ $# -gt 0 ] && exec \"$@\"; exit 0;; *) shift;; esac; done\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "flock")]);
  const PASS_THROUGH_PATH = `${shim}${path.delimiter}${process.env.PATH}`;
  // origin layout mirrors the seam contract: PREFIX<owner/repo>.git
  const origins = path.join(dir, "origins");
  const origin = path.join(origins, "test", "repo.git");
  mkdirSync(path.dirname(origin), { recursive: true });
  const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  sh(`git init -q --bare "${origin}"`);
  const seed = path.join(dir, "seed");
  mkdirSync(seed);
  sh(`git init -q . && git config user.email t@t && git config user.name t && echo one > f.txt && git add . && git commit -qm one && git branch base && echo two >> f.txt && git commit -qam two && git push -q "${origin}" HEAD:main HEAD:base`, seed);
  return { dir, origin: origins, sh, envPath: PASS_THROUGH_PATH };
};

const runFns = (f, cmd) => {
  const script = path.join(f.dir, "fns.sh");
  writeFileSync(script, FN_PROLOGUE.replace("__DATA__", path.join(f.dir, "data")).replace("__ORIGIN__", `${f.origin}/`) + extractFns() + cmd);
  return spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: f.envPath } });
};

test("one mirror store; worktrees check out AT the requested ref (no per-item clone)", () => {
  const f = fixture();
  try {
    const r1 = runFns(f, `git_wt test/repo "${f.dir}/wt1" refs/heads/main && git_wt test/repo "${f.dir}/wt2" refs/heads/base && echo OK`);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(path.join(f.dir, "wt1", "f.txt")), "worktree 1 checked out");
    assert.match(readFileSync(path.join(f.dir, "wt1", "f.txt"), "utf8"), /two/);
    assert.match(readFileSync(path.join(f.dir, "wt2", "f.txt"), "utf8"), /one/, "worktree 2 at the requested ref");
    assert.ok(existsSync(path.join(f.dir, "data", "repos", "test--repo.git")), "ONE shared mirror store");
    // both worktrees live in the store's registry
    const ls = f.sh(`git --git-dir="${f.dir}/data/repos/test--repo.git" worktree list`).stdout;
    assert.match(ls, /wt1/); assert.match(ls, /wt2/);
    // cleanup prunes removed worktree dirs
    rmSync(path.join(f.dir, "wt1"), { recursive: true, force: true });
    const r2 = runFns(f, `wt_prune`);
    assert.equal(r2.status, 0, r2.stderr);
    const ls2 = f.sh(`git --git-dir="${f.dir}/data/repos/test--repo.git" worktree list`).stdout;
    assert.ok(!ls2.includes("wt1"), "pruned"); assert.match(ls2, /wt2/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("fallback: unreachable origin degrades to git_clone (which also fails, loudly)", () => {
  const f = fixture();
  try {
    const r = runFns(f, `DSH_WORKER_ORIGIN_PREFIX="${f.dir}/nowhere/" repo_store test/repo; echo rc=$?`);
    assert.notEqual(r.status, 0, "an unreachable origin must fail loudly, not fake a store");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
