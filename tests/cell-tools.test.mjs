// cell-tools.test.mjs — tests for the ensure_cell_tools bootstrap and
// install_gh_release in scripts/run-dsh-agent.sh.
//
// Regression anchor: secondsee reviews 2026-08-26 (runs 32944063408,
// 32941451004, 32944305508). Widening runner-labels to ["self-hosted"]
// made reviews a lottery across cells, and mac-mini-secondsee /
// prod-secondsee had no gh/doppler on the runner SERVICE PATH: the
// driver died at `doppler run` with a bare "command not found" and the
// relay step 127'd on `gh pr comment`. The bootstrap: probe known
// prefixes onto PATH first, publish additions to GITHUB_PATH (later
// steps in the job), install what's still missing into a persistent
// user prefix, and fail LOUD — doppler hard (the driver launches through
// it), gh soft (the driver's own gh uses are guarded; the workflows'
// relay guards own its absence — review r1 finding 2).
//
// All offline: the ambient PATH stays intact (shims are PREPENDED, and
// absence is constructed with the script's explicit NODE_BIN/DOPPLER_BIN/
// GH_BIN seams — the lanes install real CLIs in system dirs, so PATH
// restriction constructs nothing, gates run 32933615526's lesson). curl
// is shimmed to serve fixture payloads; the gh install tests exercise
// the REAL asset shapes (linux .tar.gz with bin/ nested two levels,
// macOS .zip ONLY — the r0 code 404'd on mac and mis-stripped on linux,
// review r1 finding 1). These tests fail without the fix.
//
// Review r2 (verdict of 2026-08-26T08:33Z) pins: the doppler-install
// stderr capture bound to curl with the tail asserted INSIDE the hint
// (finding 3), GITHUB_PATH published exactly once across the 3 probe
// calls a bare cell drives (finding 4), and node checked after the
// probe that can rescue it (finding 6).

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
// PATH restriction. GITHUB_PATH is ALWAYS deleted from the inherited env:
// the probe APPENDS to it, and on a GitHub runner it always exists — the
// suite would leave stale /tmp entries in every later step's PATH
// (review r1 finding 3). The dedicated GITHUB_PATH test points its own
// at tmp.
//
// strict: true runs the same script under `bash -euo pipefail` — the
// DRIVER's own shell context, which the plain harness omits. A failed
// command substitution feeding an assignment aborts there while the
// plain harness sails past it (the residual on 3f690a2: a no-egress
// version-resolve killed the driver before the soft-gh warning / the
// doppler hint could print).
const runFn = ({ fn, args = "", tools = [], extra = "", curlShim = null, unzipShim = null, strict = false } = {}) => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const shims = mkdtempSync(path.join(tmpdir(), "celltools-shims-"));
  for (const t of tools) writeTool(shims, t);
  if (curlShim) { writeFileSync(path.join(shims, "curl"), curlShim); chmodSync(path.join(shims, "curl"), 0o755); }
  // Only when the host lacks unzip: a python3-backed -p implementation so
  // the darwin test is hermetic on slim hosts (mac cells ship unzip).
  if (unzipShim) { writeFileSync(path.join(shims, "unzip"), unzipShim); chmodSync(path.join(shims, "unzip"), 0o755); }
  const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, HOME: home };
  delete env.GITHUB_PATH;
  const defs = fn === "ensure_cell_tools"
    ? extractFunction("cell_probe_prefixes") + extractFunction("install_gh_release") + extractFunction(fn)
    : extractFunction(fn);
  const r = strict
    ? spawnSync("bash", ["-euo", "pipefail", "-c", `CELL_ADDED_PREFIXES=""\n${extra}\n${defs}\n${fn} ${args}`], { env, encoding: "utf8" })
    : spawnSync("bash", ["-c", `${extra}\n${defs}\n${fn} ${args}`], { env, encoding: "utf8" });
  return { r, home, shims };
};

const clean = (t, ...extraDirs) => {
  rmSync(t.home, { recursive: true, force: true });
  rmSync(t.shims, { recursive: true, force: true });
  for (const d of extraDirs) rmSync(d, { recursive: true, force: true });
};

// gh asset fixtures in the EXACT release layout (review r1 finding 1):
// linux tarball root = gh_<ver>_<flavor>/bin/gh; mac zip member = same
// path. Built with real tar / python3 zipfile — no fake layouts. BOTH
// flavors are included because the member name is derived from the HOST's
// uname -m at runtime — the test cannot choose it.
const ghVersion = "9.9.9";
const buildLinuxTarball = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "celltools-ghsrc-"));
  for (const flavor of ["amd64", "arm64"]) {
    const nested = path.join(dir, `gh_${ghVersion}_linux_${flavor}`, "bin");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(nested, "gh"), 0o755);
  }
  const tgz = path.join(dir, "gh.tgz");
  spawnSync("tar", ["-czf", tgz, "-C", dir, `gh_${ghVersion}_linux_amd64`, `gh_${ghVersion}_linux_arm64`]);
  return { tgz, dir };
};
const buildMacZip = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "celltools-ghzip-"));
  const zip = path.join(dir, "gh.zip");
  const py = spawnSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for flavor in ("arm64", "amd64"):
        z.writestr(f"gh_${ghVersion}_macOS_{flavor}/bin/gh", "#!/bin/sh\\nexit 0\\n")
`, zip]);
  if (py.status !== 0) throw new Error("fixture zip build failed");
  return { zip, dir };
};
// unzip -p semantics, python-backed (used only on hosts without unzip)
const pyUnzipShim = `#!/bin/sh
# unzip -p <zip> <member-glob> — print matching member to stdout
zip=""; pat=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) ;;
    *) if [ -z "$zip" ]; then zip="$1"; else pat="$1"; fi ;;
  esac
  shift
done
exec python3 -c '
import fnmatch, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    for n in z.namelist():
        if fnmatch.fnmatch(n, sys.argv[2]):
            sys.stdout.buffer.write(z.read(n)); break
' "$zip" "$pat"
`;
const hostHasUnzip = () => spawnSync("sh", ["-c", "command -v unzip >/dev/null 2>&1"]).status === 0;

// curl shim for install_gh_release: resolves the latest redirect, serves
// the linux tarball to stdout, and honors -o <path> for the mac zip.
const ghCurlShim = ({ tgz, zip }) => `#!/bin/sh
out=""
a="\$*"
while [ \$# -gt 0 ]; do
  [ "\$1" = "-o" ] && out="\$2"
  shift
done
case "\$a" in
  *releases/latest*) echo "https://github.com/cli/cli/releases/tag/v${ghVersion}" ;;
  *linux_amd64.tar.gz*|*linux_arm64.tar.gz*) cat "${tgz}" ;;
  *macOS_arm64.zip*|*macOS_amd64.zip*)
    [ -n "\$out" ] && cp "${zip}" "\$out" || cat "${zip}" ;;
  *) echo "unexpected curl call: \$a" >&2; exit 1 ;;
esac
`;

test("tools present: no install attempted (curl shim fails loudly if called)", () => {
  const t = runFn({
    fn: "ensure_cell_tools",
    curlShim: "#!/bin/sh\necho 'curl must not run when tools are present' >&2\nexit 99\n",
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS=''",
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout + t.r.stderr, /node\/doppler present \(PATH ok; gh: present\)/);
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
    assert.match(t.r.stdout + t.r.stderr, /node\/doppler present \(PATH ok; gh: present\)/);
    assert.doesNotMatch(t.r.stdout + t.r.stderr, /curl must not run/);
  } finally { clean(t, prefix); }
});

test("bare cell: prefix additions publish to GITHUB_PATH EXACTLY ONCE (3 probe calls, no triplicate — r2 finding 4)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const gp = path.join(home, "github-path");
  writeFileSync(gp, "");
  const p1 = mkdtempSync(path.join(tmpdir(), "celltools-prefix-"));
  const cellBin = path.join(home, "cellbin"); // does NOT exist yet — the
  // doppler installer creates it, so only the POST-INSTALL re-probe adds it
  const t = runFn({
    fn: "ensure_cell_tools",
    // doppler missing (seam path into the not-yet-created prefix) →
    // install → re-probe; gh missing + failing resolve → third probe:
    // the exact 3-call sequence a bare cell drives through the function.
    extra: `HOME='${home}' CELL_BIN='${cellBin}' CELL_PROBE_DIRS='${p1} ${cellBin}' DOPPLER_BIN='${cellBin}/doppler' GH_BIN='/nonexistent/gh' GITHUB_PATH='${gp}'`,
    curlShim: `#!/bin/sh
case "$*" in
  *cli.doppler.com/install.sh*)
    printf '#!/bin/sh\\ndir=""\\nwhile [ $# -gt 0 ]; do [ "$1" = "--install-path" ] && dir="$2"; shift; done\\n[ -n "$dir" ] || exit 1\\nmkdir -p "$dir"\\nprintf "#!/bin/sh\\\\nexit 0\\\\n" > "$dir/doppler"\\nchmod +x "$dir/doppler"\\n'
    ;;
  *releases/latest*) echo "curl: (7) no route to host" >&2; exit 7 ;;
  *) echo "unexpected curl call: $*" >&2; exit 1;;
esac
`,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr); // doppler installed; gh stays soft
    assert.equal(
      readFileSync(gp, "utf8"),
      `${p1}\n${cellBin}\n`,
      "each probed-in prefix must appear exactly once — the per-call publish appended them on every probe (p1 ×3, cellBin ×2 on the r1 code)",
    );
  } finally { clean(t, p1); }
});

test("missing node fails loud with the provisioning hint (hard requirement)", () => {
  const t = runFn({ fn: "ensure_cell_tools", extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' NODE_BIN=/nonexistent/node" });
  try {
    assert.notEqual(t.r.status, 0);
    assert.match(t.r.stderr, /node missing on this cell/);
  } finally { clean(t); }
});

test("node lives only under a probeable prefix: the probe finds it BEFORE the hard fail (r2 finding 6)", () => {
  const prefix = mkdtempSync(path.join(tmpdir(), "celltools-prefix-"));
  // Absence constructed by NAME (a stub name no dir on the pre-probe PATH
  // carries), the BIN-seam way — never by restricting PATH (the lanes
  // install the real CLIs in system dirs; tests-lint rejects that).
  writeTool(prefix, "node9-stub");
  const t = runFn({
    fn: "ensure_cell_tools", tools: ["doppler", "gh"],
    extra: `CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='${prefix}' NODE_BIN='node9-stub'`,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stdout + t.r.stderr, /node\/doppler present \(PATH ok; gh: present\)/);
    assert.doesNotMatch(t.r.stderr, /node missing on this cell/);
  } finally { clean(t, prefix); }
});

test("missing doppler: official installer invoked, binary lands in the persistent prefix", () => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const cellBin = path.join(home, "cellbin");
  const t = runFn({
    fn: "ensure_cell_tools", tools: ["node", "gh"],
    extra: `HOME='${home}' CELL_BIN='${cellBin}' CELL_PROBE_DIRS='${cellBin}' DOPPLER_BIN='${cellBin}/doppler'`,
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
    assert.match(t.r.stdout + t.r.stderr, /node\/doppler present \(PATH ok; gh: present\)/);
  } finally { clean(t); }
});

test("doppler present + gh uninstallable: agent still runs (gh is soft — warning, not death)", () => {
  const t = runFn({
    fn: "ensure_cell_tools", tools: ["node", "doppler"],
    curlShim: "#!/bin/sh\nexit 1\n", // no egress: version resolve fails
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' GH_BIN=/nonexistent/gh",
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stderr, /::warning::gh unavailable on this cell/);
    assert.match(t.r.stdout + t.r.stderr, /node\/doppler present \(PATH ok; gh: absent\)/);
  } finally { clean(t); }
});

test("driver context (set -euo pipefail), no egress + doppler missing: fails LOUD and the hint carries curl's tail IN it (r2 finding 3)", () => {
  const t = runFn({
    fn: "ensure_cell_tools", strict: true,
    tools: ["node", "gh"],
    curlShim: "#!/bin/sh\necho 'simulated: no route to host' >&2\nexit 7\n",
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' DOPPLER_BIN=/nonexistent/doppler",
  });
  try {
    assert.notEqual(t.r.status, 0);
    assert.match(t.r.stderr, /still missing after bootstrap: doppler/);
    assert.match(t.r.stderr, /provision the runner service PATH/);
    // The transport error must surface INSIDE the hint (after its header),
    // not by leaking from an unredirected curl. The r1 code bound 2> to
    // the pipeline TAIL (sh): under pipefail the branch fired but the
    // tail printed EMPTY; without pipefail the branch never fired at all
    // and the old assertion passed on the leak. Both holes closed here —
    // strict mode for the branch, positional match for the capture.
    assert.match(t.r.stderr, /install\.sh failed:\n\s+simulated: no route to host/);
  } finally { clean(t); }
});

test("install_gh_release (linux): tarball in the REAL layout lands AT $CELL_BIN/gh (strip 2)", () => {
  const { tgz, dir: fdir } = buildLinuxTarball();
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const cellBin = path.join(home, "cellbin");
  const t = runFn({
    fn: "install_gh_release", args: "linux",
    extra: `HOME='${home}' CELL_BIN='${cellBin}'`,
    curlShim: ghCurlShim({ tgz, zip: "/nonexistent.zip" }),
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.ok(existsSync(path.join(cellBin, "gh")), "binary at $CELL_BIN/gh — NOT bin/gh (r0 strip bug)");
    assert.doesNotMatch(t.r.stdout + t.r.stderr, /failed/);
  } finally { clean(t, fdir); }
});

test("install_gh_release (darwin): zip asset (macOS ships NO tarball — r0 404) lands AT $CELL_BIN/gh", () => {
  const { zip, dir: fdir } = buildMacZip();
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const cellBin = path.join(home, "cellbin");
  const t = runFn({
    fn: "install_gh_release", args: "darwin",
    extra: `HOME='${home}' CELL_BIN='${cellBin}'`,
    curlShim: ghCurlShim({ tgz: "/nonexistent.tgz", zip }),
    unzipShim: hostHasUnzip() ? null : pyUnzipShim,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.ok(existsSync(path.join(cellBin, "gh")), "binary extracted from the zip at $CELL_BIN/gh");
    const content = readFileSync(path.join(cellBin, "gh"), "utf8");
    assert.match(content, /exit 0/, "extracted the actual member, not an error page");
    assert.doesNotMatch(t.r.stdout + t.r.stderr, /failed/);
  } finally { clean(t, fdir); }
});

// --- residuals on 3f690a2, found while verifying the sibling fix -------
// The DRIVER runs ensure_cell_tools under `set -euo pipefail`; these run
// the same extracted functions in exactly that shell context. On 3f690a2
// a no-egress version-resolve aborted the driver at the GH_VER
// assignment — before the soft-gh warning (soft test) and before the
// doppler hard-fail hint (loud test) could print. The abort was silent:
// no hint, no agent launch.

test("driver context (set -euo pipefail), gh resolve fails: the soft-gh warning must still print (residual on 3f690a2)", () => {
  const t = runFn({
    fn: "ensure_cell_tools", strict: true,
    tools: ["node", "doppler"],
    curlShim: "#!/bin/sh\necho 'curl: (7) no route to host' >&2\nexit 7\n",
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' GH_BIN=/nonexistent/gh",
  });
  try {
    assert.equal(t.r.status, 0, `must exit 0 (gh is soft), stderr: ${t.r.stderr}`);
    assert.match(t.r.stderr, /::warning::gh unavailable on this cell/);
    assert.match(t.r.stderr, /could not resolve latest gh release:/);
  } finally { clean(t); }
});

test("driver context (set -euo pipefail), no egress + doppler missing: the loud hint must still print (residual on 3f690a2)", () => {
  const t = runFn({
    fn: "ensure_cell_tools", strict: true,
    tools: ["node", "gh"],
    curlShim: "#!/bin/sh\necho 'curl: (7) no route to host' >&2\nexit 7\n",
    extra: "CELL_BIN=/tmp/celltools-none CELL_PROBE_DIRS='' DOPPLER_BIN=/nonexistent/doppler GH_BIN=/nonexistent/gh",
  });
  try {
    assert.notEqual(t.r.status, 0);
    assert.match(t.r.stderr, /still missing after bootstrap: doppler/);
    assert.match(t.r.stderr, /provision the runner service PATH/);
  } finally { clean(t); }
});

test("failed darwin extract leaves NO empty gh artifact in the persistent prefix (residual tidy on 3f690a2)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "celltools-home-"));
  const cellBin = path.join(home, "cellbin");
  const t = runFn({
    fn: "install_gh_release", args: "darwin",
    extra: `HOME='${home}' CELL_BIN='${cellBin}'`,
    // resolve succeeds, download "succeeds" but the payload is not a zip:
    // unzip fails, and the > redirect has already created $CELL_BIN/gh
    curlShim: `#!/bin/sh
out=""
prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
case "$*" in
  *releases/latest*) echo "https://github.com/cli/cli/releases/tag/v9.9.9" ;;
  *releases/download*) printf 'not-a-zip' > "$out" ;;
  *) echo "unexpected curl call: $*" >&2; exit 1 ;;
esac
`,
    unzipShim: hostHasUnzip() ? null : pyUnzipShim,
  });
  try {
    assert.equal(t.r.status, 0, t.r.stderr);
    assert.match(t.r.stderr, /gh zip extract failed:/);
    assert.ok(!existsSync(path.join(cellBin, "gh")), "the redirect-created empty artifact must be removed, not linger");
  } finally { clean(t); }
});
