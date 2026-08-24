#!/usr/bin/env node
// workflow-lint.mjs — structural lint for GitHub workflow YAML, no dependencies.
//
// Regression anchor: agent-dispatch run 32705244305. PR #9 landed the flight
// recorder step at 4-space indent inside a steps: list whose items live at
// 6 — a sequence item dedenting onto the mapping level. GitHub could not
// parse the file ("workflow file issue", zero jobs started) and every
// workflow_call dispatch 422'd until PR #10 re-indented it by hand. The
// gates.yml "Workflow YAML parses" step only rejected tabs, so the broken
// file merged green; this tool closes that hole.
//
// What it checks (block-structure subset — enough to catch the defect
// class without reimplementing a YAML parser):
//   - every sequence item ('- ...') hangs off an empty-value mapping key
//     (the key that opened its sequence), at ONE consistent indent column;
//   - a sequence item may sit at its key's own column (the legal
//     'steps:\n- name:' style) but never dedents onto a mapping level that
//     already holds keys or a filled value;
//   - mapping keys do not nest under keys that already have a value;
//   - no tab indentation.
// Block scalars (run: |, runs-on: >-) are skipped as opaque text.

import { readFileSync } from "node:fs";

/** Split a raw line into (indent, body); body is the line minus leading spaces. */
const splitIndent = (raw) => {
  const m = /^ */.exec(raw)[0];
  return { indent: m.length, body: raw.slice(m.length) };
};

/**
 * Lint one workflow file's text.
 * @param {string} text raw YAML
 * @param {string} name display name for messages
 * @returns {{line: number, message: string}[]} errors (empty = clean)
 */
export function lintWorkflow(text, name = "workflow") {
  const errors = [];
  const lines = text.split(/\r?\n/);

  /** @type {{indent: number, kind: "map"|"seq", line: number}[]} */
  let stack = [];
  // Most recent mapping key line, and whether its value slot is filled.
  // When a sequence opens under key K, K's slot is filled by that sequence.
  let pendingKey = null;
  // Active block scalar: content = every following line deeper than keyIndent.
  let scalar = null;

  const err = (line, message) => errors.push({ line, message: `${name}:${line}: ${message}` });

  for (let i = 0; i < lines.length; i++) {
    const no = i + 1;
    const raw = lines[i];
    const { indent, body } = splitIndent(raw);

    // Block-scalar bodies are opaque text until a line dedents past the
    // header key's column (blank lines belong to the scalar).
    if (scalar) {
      if (body === "" || indent > scalar.keyIndent) continue;
      scalar = null; // this line re-enters normal processing below
    }

    if (body === "") continue;
    if (body.startsWith("#")) continue;
    if (body === "---" || body === "...") { // document markers reset scope
      stack = [];
      pendingKey = null;
      continue;
    }
    if (/^\s*\t/.test(raw)) {
      err(no, "tab indentation (YAML requires spaces)");
      continue;
    }

    const seqMatch = /^-(?:\s+(.*))?$/.exec(body);
    const keyMatch = seqMatch ? null : /^([^:#\s][^:]*?):(?:\s+(.*))?$/.exec(body);

    if (seqMatch) {
      // ---- sequence item line ----
      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (top && top.kind === "seq" && top.indent === indent) {
        // sibling item of the open sequence — the one legal case
      } else if (top && top.kind === "map" && top.indent === indent) {
        // '- item' at a mapping key's own column: legal ONLY as the value
        // of the key that just opened (steps:\n- name: ...). Any other
        // key state means this item dedented out of a deeper sequence and
        // landed on a mapping level — the run-32705244305 defect.
        if (pendingKey && pendingKey.indent === indent && !pendingKey.hasValue) {
          stack.push({ indent, kind: "seq", line: no });
          pendingKey = { indent, hasValue: true };
        } else {
          err(no,
            `sequence item '- ${((seqMatch[1] ?? "").split(":")[0] || "?").trim()}' at column ${indent} ` +
            `dedents onto a mapping level — all items of one sequence must share one indent column ` +
            `(run-32705244305 defect class: the workflow file stops parsing and every dispatch 422s)`);
        }
      } else if (!top || top.indent < indent) {
        // opens a (nested) sequence; under a mapping it must hang off an
        // empty-value key of that mapping
        if (top && top.kind === "map" &&
            !(pendingKey && pendingKey.indent === top.indent && !pendingKey.hasValue)) {
          err(no,
            `sequence item at column ${indent} hangs off a mapping key that already has a value`);
        } else {
          stack.push({ indent, kind: "seq", line: no });
          if (top && top.kind === "map") pendingKey = { indent: top.indent, hasValue: true };
        }
      } else if (top && top.kind === "seq" && top.indent > indent) {
        err(no, `sequence item at column ${indent} is shallower than its sequence (opened line ${top.line})`);
      }
      continue;
    }

    if (keyMatch) {
      // ---- mapping key line ----
      while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      // a key at a sequence's item column closes that sequence and joins
      // the mapping below it (legal 'steps:\n- x\nnext-key:' style)
      if (top && top.kind === "seq" && top.indent === indent) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (top && top.kind === "seq" && top.indent === indent) {
        err(no, `mapping key at column ${indent} collides with a sequence item column`);
        continue;
      }
      const value = (keyMatch[2] ?? "").trim();
      const hasValue = value !== "" && !value.startsWith("#");
      if (!top || top.indent < indent) {
        // nested mapping — must open under an empty-value key
        if (top && top.kind === "map" &&
            !(pendingKey && pendingKey.indent === top.indent && !pendingKey.hasValue)) {
          err(no,
            `mapping key '${keyMatch[1]}' at column ${indent} nests under a key that already has a value`);
          continue;
        }
        stack.push({ indent, kind: "map", line: no });
      }
      // (top map at the same column: sibling key — always fine)
      pendingKey = { indent, hasValue };
      if (/^[|>]/.test(value)) scalar = { keyIndent: indent, line: no };
      continue;
    }

    err(no, `line is neither a mapping key nor a sequence item: '${body.slice(0, 40)}'`);
  }

  return errors;
}

/** CLI: one or more workflow files; exit 1 with per-line errors if any fail. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: workflow-lint.mjs <workflow.yml> [more.yml ...]");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch (e) {
      console.error(`workflow-lint: cannot read ${f}: ${e.message}`);
      bad++;
      continue;
    }
    for (const { message } of lintWorkflow(text, f)) {
      console.error(message);
      bad++;
    }
  }
  if (bad) process.exit(1);
}
