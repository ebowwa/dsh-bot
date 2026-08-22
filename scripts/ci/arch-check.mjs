#!/usr/bin/env node
// arch-check.mjs — boundary probe for this repo's layering:
// workflows are thin shells, scripts/ holds the machinery, config/ holds
// data. Enforced invariants:
//
//   A. Only scripts/run-dsh-agent.sh may exec the agent loop (`dsh
//      --profile`) — a workflow that grows agent-loop logic is a layering
//      violation, not a shell.
//   B. scripts/*.sh must not embed inline `node -e` JavaScript: JS lives in
//      .mjs files where `node --check` and the test suite can reach it.
//   C. config/*.yaml may reference credentials only BY NAME (`*Env:` keys
//      such as apiKeyEnv); a literal api key / token / secret / password
//      value fails the probe.
//
//   node scripts/ci/arch-check.mjs     (exit 1 on any violation)

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** An actual `node -e ...` invocation (a backtick-quoted mention in a
 *  comment does not match: `-e` must be followed by whitespace). */
export const INLINE_NODE_RE = /\bnode\s+(?:-{2}[\w-]+\s+)*-e\s+/;

export function archCheck() {
  const violations = [];

  // A. agent-loop exec stays in the driver.
  const shells = [
    ...readdirSync(join(REPO, ".github", "workflows")).map((f) =>
      join(REPO, ".github", "workflows", f),
    ),
    ...readdirSync(join(REPO, "examples")).map((f) => join(REPO, "examples", f)),
  ];
  for (const f of shells) {
    if (/dsh\s+--profile/.test(readFileSync(f, "utf8"))) {
      violations.push(`A: agent-loop exec (dsh --profile) must live only in scripts/run-dsh-agent.sh, found in ${rel(f)}`);
    }
  }

  // B. no inline JS in shell scripts — it evades node --check and tests.
  for (const f of readdirSync(join(REPO, "scripts"))) {
    const p = join(REPO, "scripts", f);
    if (!f.endsWith(".sh")) continue;
    if (INLINE_NODE_RE.test(readFileSync(p, "utf8"))) {
      violations.push(`B: inline \`node -e\` in scripts/${f} — move the JS into a .mjs file so it is checkable`);
    }
  }

  // C. config references credentials by env name only.
  //    The secret word must stand alone in the key (maxTokens is NOT one).
  const SECRET_KEY_RE = /(?:^|[^a-z0-9])(api[-_]?key|token|secret|password)(?:[^a-z0-9]|$)/i;
  for (const f of readdirSync(join(REPO, "config"))) {
    if (!/\.(ya?ml)$/.test(f)) continue;
    readFileSync(join(REPO, "config", f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const m = /^(\s*[^\s#][^:]*):\s*(\S.*)$/.exec(line);
        if (!m) return;
        const [, key, value] = m;
        if (!SECRET_KEY_RE.test(key)) return;
        if (/[Ee]nv\s*$/.test(key)) return; // name reference (apiKeyEnv: ZAI_API_KEY)
        if (/^\$\{/.test(value.trim())) return; // interpolation placeholder
        violations.push(`C: possible literal credential in config/${f}:${i + 1} — key '${key.trim()}' must be a *Env name reference`);
      });
  }

  return violations;
}

function rel(p) {
  return p.startsWith(REPO) ? p.slice(REPO.length + 1) : p;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = archCheck();
  for (const v of violations) console.error(`arch-check: FAIL  ${v}`);
  if (!violations.length) console.log("arch-check: no boundary violations");
  console.log(`arch-check: ${violations.length} violation(s)`);
  process.exit(violations.length ? 1 : 0);
}
