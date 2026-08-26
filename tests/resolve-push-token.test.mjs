// resolve-push-token.test.mjs — tests for scripts/resolve-push-token.sh.
//
// Regression anchor: factory PR #229 (2026-08-26). The agent-dispatch main
// checkout persisted the ephemeral GITHUB_TOKEN as the workspace git
// credential, so every agent `git push` rode github-actions[bot]. On PRs
// whose overall diff touches workflow files, GitHub parks bot-triggered
// runs in action_required (gates runs 32921795436/32924697952: created,
// never executed) — and a push that itself edits workflow files is
// rejected outright. These tests pin the resolver that rewrites the
// credential Doppler-first: which token lands in
// http.https://github.com/.extraheader, per failure mode, and the wiring
// of both reusable workflows around it. They fail without the fix: on the
// parent there is no script to run and no wiring to find.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "resolve-push-token.sh");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const headerFor = (tok) => `AUTHORIZATION: basic ${b64(`x-access-token:${tok}`)}`;

// A PATH with shims for `doppler` (echoes DOPPLER_OUT, exits DOPPLER_RC)
// and `curl` (prints an X-OAuth-Scopes: CURL_SCOPES header, exits
// CURL_RC) — real git/base64/tr/awk stay on PATH.
const shimPath = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-push-shims-"));
  const doppler = `#!/bin/sh
if [ "\${DOPPLER_RC:-0}" != "0" ]; then exit "\$DOPPLER_RC"; fi
printf '%s' "\${DOPPLER_OUT-}"
`;
  const curl = `#!/bin/sh
if [ "\${CURL_RC:-0}" != "0" ]; then exit "\$CURL_RC"; fi
printf 'HTTP/1.1 200 OK\\r\\nX-OAuth-Scopes: %s\\r\\n\\r\\n' "\${CURL_SCOPES-}"
`;
  writeFileSync(path.join(dir, "doppler"), doppler);
  writeFileSync(path.join(dir, "curl"), curl);
  for (const f of ["doppler", "curl"]) chmodSync(path.join(dir, f), 0o755);
  return { dir, path: `${dir}:${process.env.PATH}` };
};

// Fresh empty git repo = the job workspace after a persist-credentials:
// false checkout (no credential in config — that is the state the
// resolver must fill).
const freshRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-push-repo-"));
  const r = spawnSync("git", ["init", "-q", "."], { cwd: dir });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
};

const runResolver = (repo, envOverrides = {}) => {
  const shims = shimPath();
  const env = {
    ...process.env,
    PATH: shims.path,
    DOPPLER_SERVICE_TOKEN: "svc-token",
    PUSH_FALLBACK_CRED: "fallback-tok",
    ...envOverrides,
  };
  const r = spawnSync("bash", [SCRIPT], { cwd: repo, env, encoding: "utf8" });
  return { r, cleanup: () => rmSync(shims.dir, { recursive: true, force: true }) };
};

const headerIn = (repo) =>
  spawnSync("git", ["config", "--local", "--get", "http.https://github.com/.extraheader"],
    { cwd: repo, encoding: "utf8" }).stdout.trim();

const withCase = (fn) => () => {
  const repo = freshRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

test("doppler token with full scopes wins (scopes ok, header = doppler token)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, {
    DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "delete_repo, gist, read:org, repo, workflow",
  });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /push-token: doppler seed\/prd \(scopes ok\)/);
    assert.equal(headerIn(repo), headerFor("doppler-pat"));
  } finally { cleanup(); }
}));

test("minimal satisfiable set (repo, workflow) still takes the doppler token", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /push-token: doppler seed\/prd \(scopes ok\)/);
    assert.equal(headerIn(repo), headerFor("doppler-pat"));
  } finally { cleanup(); }
}));

test("doppler token lacking `workflow` falls back (workflow edits would be rejected)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, read:project" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lacks: workflow/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("doppler token lacking `repo` falls back (cannot write private repos)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "gist, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lacks: repo/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("doppler fetch failure falls back (never breaks the run)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_RC: "1", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /doppler fetch failed/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("doppler config without GITHUB_TOKEN falls back", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /has no GITHUB_TOKEN/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("no doppler CLI on the runner falls back (workflow secret rules)", withCase((repo) => {
  // Construct the absence: a PATH of ONLY the curl shim + system dirs —
  // the real doppler (homebrew /opt/homebrew/bin on dev machines, runner
  // PATH on the lanes) must be unreachable, and prepending a doppler-less
  // dir does NOT hide it (command -v keeps walking PATH).
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-push-nodoppler-"));
  const curl = `#!/bin/sh
printf 'HTTP/1.1 200 OK\\r\\nX-OAuth-Scopes: %s\\r\\n\\r\\n' "\${CURL_SCOPES-}"
`;
  writeFileSync(path.join(dir, "curl"), curl);
  chmodSync(path.join(dir, "curl"), 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:/usr/bin:/bin`,
    DOPPLER_SERVICE_TOKEN: "svc-token",
    PUSH_FALLBACK_CRED: "fallback-tok",
    CURL_SCOPES: "repo, workflow",
  };
  try {
    const r = spawnSync("bash", [SCRIPT], { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no doppler cli\/service token/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

test("no DOPPLER_SERVICE_TOKEN secret falls back", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_SERVICE_TOKEN: "", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no doppler cli\/service token/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("hung scope probe (curl exit 28) falls back without failing the job", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_RC: "28" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scope probe failed/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("probe answer without scopes header falls back (token invalid)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /token invalid/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("missing fallback credential fails loud (never silently unauthenticated)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { PUSH_FALLBACK_CRED: "", DOPPLER_RC: "1" });
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no fallback credential supplied/);
  } finally { cleanup(); }
}));

test("long token lands single-line (BSD base64 76-col wrap must not break the header)", withCase((repo) => {
  const longTok = `doppler-${"x".repeat(120)}`;
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: longTok, CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(headerIn(repo), headerFor(longTok));
  } finally { cleanup(); }
}));

// Class guards on the WIRING: the resolver alone fixes nothing — both
// entry points must stop persisting the ephemeral credential and run the
// resolver between the toolkits fetch and the first thing that pushes.
test("agent-dispatch.yml: persist-credentials false + resolver wired before the agent", () => {
  const wf = readFileSync(path.join(ROOT, ".github", "workflows", "agent-dispatch.yml"), "utf8");
  assert.ok(wf.includes("persist-credentials: false"), "main checkout must not persist the ephemeral token");
  assert.ok(wf.includes("resolve-push-token.sh"), "resolver must be invoked");
  const resolveIdx = wf.indexOf("Push credential (Doppler-first)");
  const checkoutIdx = wf.indexOf("persist-credentials: false");
  const runIdx = wf.indexOf("- name: Run agent");
  assert.ok(checkoutIdx !== -1 && resolveIdx !== -1 && runIdx !== -1);
  assert.ok(checkoutIdx < resolveIdx && resolveIdx < runIdx, "resolver must run after checkout, before the agent");
});

test("agent-comment.yml: persist-credentials false + resolver wired before agent AND shipper", () => {
  const wf = readFileSync(path.join(ROOT, ".github", "workflows", "agent-comment.yml"), "utf8");
  assert.ok(wf.includes("persist-credentials: false"), "main checkout must not persist the ephemeral token");
  assert.ok(wf.includes("resolve-push-token.sh"), "resolver must be invoked");
  const checkoutIdx = wf.indexOf("persist-credentials: false");
  const resolveIdx = wf.indexOf("Push credential (Doppler-first)");
  const runIdx = wf.indexOf("- name: Run agent, ship, dispatch review");
  const shipIdx = wf.indexOf("- name: Ship any code changes as a PR");
  assert.ok([checkoutIdx, resolveIdx, runIdx, shipIdx].every((i) => i !== -1));
  assert.ok(checkoutIdx < resolveIdx && resolveIdx < runIdx && runIdx < shipIdx,
    "resolver must precede both push surfaces");
});
