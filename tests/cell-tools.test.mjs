// cell-tools.test.mjs — tests for the ensure_cell_tools bootstrap in
// scripts/run-dsh-agent.sh.
//
// Regression anchor: secondsee reviews 2026-08-26 (runs 32944063408,
// 32941451004, 32944305508). Widening runner-labels to ["self-hosted"]
// made reviews a lottery across cells, and mac-mini-secondsee /
// prod-secondsee had no gh/doppler on the runner SERVICE PATH: the
// driver died at `doppler run` with a bare "command not found" and the
// relay step 127'd on `gh pr comment`. The bootstrap: probe known
// prefixes onto PATH first (the regressed-service-PATH case — tools
// exist, the service just can't see them), then install missing tools
// into a persistent user prefix, then fail LOUD with a provisioning
// hint instead of a mid-run 127.
//
// All offline: the ambient PATH stays intact (shims are PREPENDED, and
// absence is constructed with the script's explicit NODE_BIN/DOPPLER_BIN/
// GH_BIN seams — the lanes install real CLIs in system dirs, so PATH
// restriction constructs nothing, gates run 32933615526's lesson). curl
// is shimmed to serve fixture payloads. These tests fail without the
// fix: on the parent there is no ensure_cell_tools to extract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "run-dsh-agent.sh");

const extractFunction = (name) =>
  spawnSync("sed", ["-n", `/^${name}()/,/^}/p`, SCRIPT], { encoding: "utf8" }).stdout;

const writeTool = (dir, name) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(dir, name), 0o755);
};

// Run one extracted function with shims PREPENDED to the ambient PATH.
// Absence of a tool is always constructed via its *_BIN seam, never by
// PATH restriction. ensure_cell_tools needs its helper cell_probe_prefixes
// extracted alongside it, plus the top-level CELL_BIN the driver defines.
const runFn = ({ fn, tools = [], extra = "", curlShim = null } = {}) => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const shims = mkdtempSync(path.join(tmpdir(), "celltools-shims-"));
  for (const t of tools) writeTool(shims, t);
  if (curlShim) { writeFileSync(path.join(shims, "curl"), curlShim); chmodSync(path.join(shims, "curl"), 0o755); }
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, HOME: home };
  const defs = fn === "ensure_cell_tools"
    ? extractFunction("cell_probe_prefixes") + extractFunction(fn)
    : extractFunction(fn);
  const r = spawnSync("bash", ["-c", `${extra}\n${defs}\n${fn}`], { env, encoding: "utf8" });
  return { r, home, shims };
};

const clean = (t) => { rmSync(t.home, { recursive: true, force: true }); rmSync(t.shims, { recursive: true, force: true }); };

test("tools present: no install attempted (curl shim fails loudly if called)", () => {
  const t = runFn({
    fn: "ensure_cell_tools",
    curlShim: "#!/bin/sh\necho 'curl must not run when tools are present' >&2\nexit 99\n",
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS=''",
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout + t.r.stderr, /cell-tools: node\/doppler\/gh present/);
    assert.doesNotMatch(t.r.stdout + t.r.stderr, /installing/);
    assert.doesNotMatch(t.r.stdout + t.r.stderr, /curl must not run/);
  } finally { clean(t); }
});

test("regressed service PATH: tools exist under a probeable prefix — probing fixes it, no install", () => {
  const prefix = mkdtempSync(path.join(tmpdir(), "celltools-prefix-"));
  writeTool(prefix, "doppler"); writeTool(prefix, "gh");
  const t = runFn({
    fn: "ensure_cell_tools",
    curlShim: "#!/bin/sh\necho 'curl must not run' >&2\nexit 99\n",
    extra: `CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='${prefix}' DOPPLER_BIN='${prefix}/doppler' GH_BIN='${prefix}/gh'`,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout + t.r.stderr, /cell-tools: node\/doppler\/gh present/);
    assert.doesNotMatch(t.r.stdout + t.r.stderr, /curl must not run/);
  } finally { clean(t); rmSync(prefix, { recursive: true, force: true }); }
});

test("cell_probe_prefixes publishes every added dir to GITHUB_PATH (later steps must find gh)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const gp = path.join(home, "github-path");
  writeFileSync(gp, "");
  const cellBin = path.join(home, ".dsh-bot-bin");
  writeTool(cellBin, "gh");
  const t = runFn({
    fn: "cell_probe_prefixes",
    extra: `HOME='${home}' CELL_PROBE_DIRS='${cellBin}' GITHUB_PATH='${gp}'`,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.equal(readFileSync(gp, "utf8"), cellBin + "\n");
  } finally { clean(t); }
});

test("missing node fails loud with the provisioning hint (hard requirement)", () => {
  const t = runFn({ fn: "ensure_cell_tools", extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' NODE_BIN=/nonexistent/node" });
  try {
    assert.notEqual(t.r.status, 0);
    assert.match(t.r.stderr, /node missing on this cell/);
  } finally { clean(t); }
});

test("missing doppler: official installer invoked, binary lands in the persistent prefix", () => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const cellBin = path.join(home, "cellbin");
  const t = runFn({
    fn: "ensure_cell_tools",
    // DOPPLER_BIN points INTO the persistent prefix: absent before install
    // (command -v on a nonexistent path), present after — the real
    // resolution contract, exercised without touching the ambient PATH.
    extra: `HOME='${home}' CELL_BIN='${cellBin}' CELL_PROBE_DIRS='${cellBin}' DOPPLER_BIN='${cellBin}/doppler'`,
    // curl shim: serve an installer that writes a fake doppler into the
    // --install-path it is given — exactly the contract install.sh honors.
    curlShim: `#!/bin/sh
case "$*" in
  *cli.doppler.com/install.sh*)
    printf '#!/bin/sh\\ndir=""\\nwhile [ $# -gt 0 ]; do [ "$1" = "--install-path" ] && dir="$2"; shift; done\\n[ -n "$dir" ] || exit 1\\nmkdir -p "$dir"\\nprintf "#!/bin/sh\\\\nexit 0\\\\n" > "$dir/doppler"\\nchmod +x "$dir/doppler"\\n'
    ;;
  *) echo "unexpected curl call: $*" >&2; exit 1;;
esac
`,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout + t.r.stderr, /installing/);
    assert.ok(existsSync(path.join(cellBin, "doppler")), "installer placed the binary in the persistent prefix");
    assert.match(t.r.stdout + t.r.stderr, /cell-tools: node\/doppler\/gh present/);
  } finally { clean(t); }
});

test("no egress at all: fails LOUD with the provisioning hint (never limps)", () => {
  const t = runFn({
    fn: "ensure_cell_tools",
    curlShim: "#!/bin/sh\nexit 1\n",
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' DOPPLER_BIN=/nonexistent/doppler",
  });
  try {
    assert.notEqual(t.r.status, 0);
    assert.match(t.r.stderr, /still missing after bootstrap: doppler/);
    assert.match(t.r.stderr, /provision the runner service PATH/);
  } finally { clean(t); }
});
