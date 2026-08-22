#!/usr/bin/env node
// write-settings.mjs — regenerate a DSH settings.yaml from the pristine
// template with THIS run's model applied, then verify the result.
//
//   node write-settings.mjs <template.yaml> <provider/model> <dest.yaml>
//
// Why this file exists (incident background): the overlay used to live in
// the driver as an inline `node -e` one-liner whose regex literal was
// reformatted across lines — a JavaScript SyntaxError. The driver's
// `|| cp` fallback swallowed it, so every DSH_MODEL override silently
// no-oped while the log claimed otherwise; the release-review agent caught
// it and blocked the tag (drift-check run 32548668443). Inline JS cannot be
// syntax-checked or unit-tested; this file can.
//
// Contract — FAIL CLOSED:
//   * dest is written ONLY from a template whose top-level
//     `agent-default-model:` block carries two-space `provider:` and
//     `model:` children (block style; values may be quoted or carry
//     trailing comments — the child line is replaced wholesale).
//   * After writing, dest is re-read and re-parsed; unless
//     agent-default-model resolves to exactly <provider>/<model>, exit 1.
//   * Any missing anchor, unreadable file, or write error exits 1 with a
//     precise message on stderr. Success is silent (exit 0, no stdout).

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const USAGE = "usage: node write-settings.mjs <template.yaml> <provider/model> <dest.yaml>";

function fail(msg) {
  console.error(`write-settings: error: ${msg}`);
  process.exit(1);
}

const [templatePath, route, destPath] = process.argv.slice(2);
if (!templatePath || !route || !destPath) fail(USAGE);

if (!/^[^\s/]+\/[^\s/]+$/.test(route)) {
  fail(`model must be provider/model with no whitespace (got '${route}')`);
}
const [provider, model] = route.split("/");

let template;
try {
  template = readFileSync(templatePath, "utf8");
} catch (e) {
  fail(`cannot read template: ${e.message}`);
}

// Windows-line-ending templates keep their separator (rewritten lines must
// not introduce mixed endings).
const nl = template.includes("\r\n") ? "\r\n" : "\n";

// A top-level YAML mapping key (column 0) ends the agent-default-model block.
const TOP_KEY = /^[A-Za-z][\w.-]*:/;
// An indented `key:` child line; value (possibly empty) may follow.
const CHILD_KEY = /^(\s+)([\w.-]+):[ \t]*(.*)$/;

/**
 * Walk the agent-default-model block and rewrite its provider/model child
 * lines. Returns { ok, text } or { ok: false, reason }.
 */
function applyRoute(text) {
  const lines = text.split(nl);
  const start = lines.findIndex((l) => /^agent-default-model:[ \t]*$/.test(l));
  if (start === -1) {
    return {
      ok: false,
      reason:
        "template has no block-style top-level 'agent-default-model:' key " +
        "(flow style or missing block is not supported)",
    };
  }
  let sawProvider = false;
  let sawModel = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (TOP_KEY.test(line)) break; // next top-level key: block ended
    const m = CHILD_KEY.exec(line);
    if (!m) continue; // blank line, comment, or list item
    const [, indent, key] = m;
    if (indent !== "  ") continue; // deeper nesting: not a direct child
    if (key === "provider") {
      lines[i] = `  provider: ${provider}`;
      sawProvider = true;
    } else if (key === "model") {
      lines[i] = `  model: ${model}`;
      sawModel = true;
    }
  }
  if (!sawProvider || !sawModel) {
    const missing = !sawProvider && !sawModel ? "'provider:' and 'model:'" : !sawProvider ? "'provider:'" : "'model:'";
    return {
      ok: false,
      reason: `agent-default-model block is missing the two-space ${missing} child`,
    };
  }
  return { ok: true, text: lines.join(nl) };
}

/** Read-side parser used for post-write verification. */
function parseRoute(text) {
  const lines = text.split(nl);
  const start = lines.findIndex((l) => /^agent-default-model:[ \t]*$/.test(l));
  if (start === -1) return null;
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP_KEY.test(lines[i])) break;
    const m = CHILD_KEY.exec(lines[i]);
    if (!m) continue;
    const [, indent, key, rest] = m;
    if (indent !== "  ") continue;
    if (key === "provider" || key === "model") {
      let v = rest.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[key] = v;
    }
  }
  return out.provider && out.model ? { provider: out.provider, model: out.model } : null;
}

const applied = applyRoute(template);
if (!applied.ok) fail(applied.reason);

try {
  writeFileSync(destPath, applied.text);
} catch (e) {
  fail(`cannot write destination: ${e.message}`);
}

let written;
try {
  written = readFileSync(destPath, "utf8");
} catch (e) {
  fail(`cannot re-read destination for verification: ${e.message}`);
}

const got = parseRoute(written);
if (!got || got.provider !== provider || got.model !== model) {
  fail(
    `verification failed: destination agent-default-model resolves to ` +
      `'${got ? `${got.provider}/${got.model}` : "nothing"}', expected '${provider}/${model}'`,
  );
}
