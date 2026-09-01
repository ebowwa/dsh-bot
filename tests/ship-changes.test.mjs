// ship-changes.test.mjs — hermetic tests for scripts/ship-changes.sh, the
// deterministic shipper shared by the legacy workflow AND the decoupled
// worker. No network: a local bare remote + a `gh` shim (PATH-prepended,
// the blessed construction) stand in for GitHub. The shipper must be the
// ONLY pusher: it creates the branch, commits the dirty work, pushes, and
// opens the PR through the shim — and its PR body is the SCRUBBED agent
// output, never the raw file (a planted token must come out [redacted]).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPER = path.join(ROOT, "scripts", "ship-changes.sh");

const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

/** Build a fixture: bare remote + a work clone, plus a gh shim. Returns
 * paths the test drives through the shipper. */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ship-changes-test-"));
  const bare = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const cache = path.join(dir, "cache");
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(cache, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });

  git(["init", "--bare", "-q", bare], { cwd: dir });
  git(["init", "-q", work]);
  git(["config", "user.name", "tester"], { cwd: work });
  git(["config", "user.email", "tester@example.com"], { cwd: work });
  writeFileSync(path.join(work, "a.txt"), "base content\n");
  git(["add", "a.txt"], { cwd: work });
  git(["commit", "-q", "-m", "base"], { cwd: work });
  git(["remote", "add", "origin", bare], { cwd: work });
  git(["push", "-q", "-u", "origin", "master"], { cwd: work });
  const head = git(["rev-parse", "HEAD"], { cwd: work }).stdout.trim();

  // gh shim: logs every call; answers pr create / pr view; copies the
  // --body-file it is handed for the scrub assertion.
  const ghLog = path.join(logs, "gh.log");
  const prBodyOut = path.join(logs, "pr-body.md");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
case " $* " in
  *" pr create "*)
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--body-file" ]; then cp "$a" "$PR_BODY_OUT" 2>/dev/null || true; fi
      prev="$a"
    done
    echo "https://github.com/owner/repo/pull/999" ;;
  *" --json number "*) echo 99 ;;
  *" --json state "*) echo OPEN ;;
  *) exit 0 ;;
esac
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  return { dir, bare, work, cache, shim, logs, ghLog, prBodyOut, head,
    env: (extra = {}) => ({
      GH_TOKEN: "fake-token", DSH_SHIP_REPO: "owner/repo", DSH_RUN_ID: "testrun",
      DSH_RUN_ATTEMPT: "1", DSH_WORKTREE: work, DSH_BOT_DIR: ROOT,
      DSH_SHIP_CACHE: cache, DSH_AGENT_OUTPUT: path.join(cache, "dsh-agent-output.txt"),
      DSH_SHIP_NOTE_FILE: path.join(cache, "ship-note.txt"),
      DSH_PR_NUM_FILE: path.join(cache, "pr-num"),
      DSH_TASK_TITLE: "task title",
      REVIEW_WORKFLOW: "",
      GH_LOG: ghLog, PR_BODY_OUT: prBodyOut,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

test("shipper commits dirty work, pushes a dsh/auto branch, opens a PR through gh", () => {
  const f = fixture();
  try {
    // before-state (what the workflow/worker captures pre-agent)
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    // the agent's output, with a planted credential the PR body must scrub
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"),
      "done — summary: fixed the bug. token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 used\n");
    // the agent left DIRTY work behind
    writeFileSync(path.join(f.work, "a.txt"), "base content\nagent changed it\n");

    const res = spawnSync("bash", [SHIPPER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);

    // pushed branch exists on the remote
    const refs = git(["ls-remote", f.bare]).stdout;
    assert.match(refs, /refs\/heads\/dsh\/auto-rtestruna1/);

    // PR was "opened" through the shim and its number recorded
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /pr create/);
    assert.equal(readFileSync(path.join(f.cache, "pr-num"), "utf8").trim(), "99");

    // ship note says shipped
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /shipped/);

    // the PR body carries the SCRUBBED output: [redacted], never the token
    const body = readFileSync(f.prBodyOut, "utf8");
    assert.match(body, /fixed the bug/);
    assert.match(body, /\[redacted:token\]/);
    assert.ok(!body.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("clean worktree → nothing to ship, no PR opened, no branch created", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "nothing changed\n");

    const res = spawnSync("bash", [SHIPPER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    const note = readFileSync(path.join(f.cache, "ship-note.txt"), "utf8");
    assert.match(note, /nothing to ship/);
    const refs = git(["ls-remote", f.bare]).stdout;
    assert.ok(!refs.includes("dsh/auto-"));
    // gh is never called on a clean tree (no before-open-prs diffs, no
    // PRs to open) — the shim's log file must not even exist.
    assert.ok(!existsSync(f.ghLog), "no PR should be opened when nothing changed");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing repo context fails loudly (never ships to an unknown repo)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-before-sha"), f.head);
    writeFileSync(path.join(f.cache, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(f.cache, "dsh-before-open-prs"), "");
    const env = f.env({ DSH_SHIP_REPO: "" });
    delete env.GITHUB_REPOSITORY;
    const res = spawnSync("bash", [SHIPPER], { encoding: "utf8", env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DSH_SHIP_REPO/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});