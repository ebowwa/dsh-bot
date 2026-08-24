#!/usr/bin/env node
// workflow-lint.mjs — structural lint for GitHub workflow YAML, no dependencies.
//
// Regression anchor: agent-dispatch run 32705244305. PR #9 landed the flight
// recorder step at 4-space indent inside a steps: list whose items live at
// 6 — a sequence item dedenting onto the mapping level. GitHub could not
// parse the file ("workflow file issue", zero jobs started) and every
// workflow_call dispatch 422'd until PR #10 re-indented it by hand. The
// gates.yml "Workflow YAML parses" step only rejected tabs, so the file
// passed that check green (the drift check was red; gates alone waved it
// through); this tool closes that hole.
//
// What it checks (block-structure subset — enough to catch the defect
// class without reimplementing a YAML parser):
//   - a sequence item either sits at its sequence's item column, or is the
//     fresh content of a bare parent item, or hangs off an empty-value
//     mapping key — anything else (dedenting onto a mapping level, or
//     landing at a column BETWEEN the item column and the content column)
//     is an error: one-column-off misindents must not merge green either;
//   - mapping keys live at their mapping's column; a key may close a
//     sequence and join the map below it (the legal 'steps:\n- x\nnext:'
//     style) but may not collide with or float between open scopes;
//   - nesting under a key/item that already has a value is an error;
//   - no tab indentation.
// Block scalars (run: |, runs-on: >-) are opaque text once their base
// indent is fixed by the first content line; a dedent to between the
// header key's column and that base ends the scalar and is flagged.
// Plain multi-line scalars (key: value folded across deeper non-key
// lines) are accepted.

import { readFileSync } from "node:fs";

/** Split a raw line into (indent, body); body is the line minus leading spaces. */
const splitIndent = (raw) => {
  const m = /^ */.exec(raw)[0];
  return { indent: m.length, body: raw.slice(m.length) };
};

/** Does body look like `key:` / `key: value`? Returns [key, value|null]. */
const keyParts = (body) => {
  const m = /^([^:#\s][^:]*?):(?:\s+(.*))?$/.exec(body);
  return m ? [m[1], m[2] ?? null] : null;
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

  /**
   * Block-scope stack. Map entries: {indent, kind:'map', line}.
   * Seq entries additionally track the CURRENT item so deeper lines can be
   * checked against it: {indent, kind:'seq', line, item:{contentColumn,
   * contentKind}} — contentColumn null until the item's content starts
   * (inline `- key: v` sets it immediately; a bare `-` adopts the first
   * deeper line's column). 'scalar' content fills the item: nothing deeper.
   */
  let stack = [];
  // Most recent mapping key line, and whether its value slot is filled.
  // When a sequence opens under key K, K's slot is filled by that sequence.
  let pendingKey = null;
  // Active block scalar {keyIndent, base}: the FIRST non-blank content line
  // fixes `base`; deeper-or-equal lines are content. A non-blank line
  // between keyIndent and base terminates the scalar (a real parser does
  // the same) and re-enters structural processing, which then flags it.
  let scalar = null;
  // Column of the first significant line of the document: every doc-level
  // (stack-empty) line must share it — a root mapping/sequence at mixed
  // columns is invalid block YAML (review finding on PR #11).
  let docRootColumn = null;
  // Most recent key line carrying an inline PLAIN (non-block) value: a
  // deeper non-key line after it is a plain-scalar continuation (legal).
  let lastPlainKey = null;

  const err = (line, message) => errors.push({ line, message: `${name}:${line}: ${message}` });
  const top = () => stack[stack.length - 1];

  // Register an inline item body (`- key: v`, `- scalar`, or bare `-`).
  // Returns the seq entry's item state.
  const itemFor = (rest, inlineColumn) => {
    if (rest === null || rest === undefined) return { contentColumn: null, contentKind: null };
    const kp = keyParts(rest);
    if (kp) return { contentColumn: inlineColumn, contentKind: "map", key: kp };
    if (rest.startsWith("-")) return { contentColumn: inlineColumn, contentKind: "seq" };
    return { contentColumn: inlineColumn, contentKind: "scalar" };
  };

  for (let i = 0; i < lines.length; i++) {
    const no = i + 1;
    const raw = lines[i];
    const { indent, body } = splitIndent(raw);

    // Block-scalar handling: the first non-blank content line fixes `base`;
    // blank lines and lines at >= base are content. Anything else ends the
    // scalar — a dedent to between keyIndent and base re-enters structural
    // processing below (a real parser rejects the file there), a dedent to
    // keyIndent or less is the normal scalar end.
    if (scalar) {
      if (body === "") continue;
      if (scalar.base === null) {
        scalar.base = indent;
        continue;
      }
      if (indent >= scalar.base) continue;
      scalar = null; // this line re-enters normal processing below
    }

    if (body === "") continue;
    if (body.startsWith("#")) continue;
    if (body === "---" || body === "...") { // document markers reset scope
      stack = [];
      pendingKey = null;
      docRootColumn = null;
      lastPlainKey = null;
      continue;
    }
    if (/^\s*\t/.test(raw)) {
      err(no, "tab indentation (YAML requires spaces)");
      continue;
    }

    const seqMatch = /^-(?:\s+(.*))?$/.exec(body);
    const kp = seqMatch ? null : keyParts(body);
    if (!seqMatch && !kp) {
      // plain multi-line scalar continuation (review finding on PR #11):
      // `key: value` folds across deeper lines that are not keys
      if (lastPlainKey && indent > lastPlainKey.indent) continue;
      err(no, `line is neither a mapping key nor a sequence item: '${body.slice(0, 40)}'`);
      continue;
    }

    while (stack.length && indent < top().indent) stack.pop();

    if (seqMatch) {
      // ---- sequence item line ----
      lastPlainKey = null; // structural line: no plain continuation carries past it
      const rest = seqMatch[1] ?? null;
      // column of the inline content (after "- "), if any
      const inlineColumn = rest === null ? null : indent + (body.length - rest.length);
      let t = top();
      if (t && t.kind === "seq" && t.indent === indent) {
        // sibling item of the open sequence — resets the current item
        t.item = itemFor(rest, inlineColumn);
      } else if (t && t.kind === "map" && t.indent === indent) {
        // '- item' at a mapping key's own column: legal ONLY as the value
        // of the key that just opened (steps:\n- name: ...). Any other
        // key state means this item dedented out of a deeper sequence and
        // landed on a mapping level — the run-32705244305 defect.
        if (pendingKey && pendingKey.indent === indent && !pendingKey.hasValue) {
          stack.push({ indent, kind: "seq", line: no, item: itemFor(rest, inlineColumn) });
          pendingKey = { indent, hasValue: true };
        } else {
          err(no,
            `sequence item '- ${((rest ?? "").split(":")[0] || "?").trim()}' at column ${indent} ` +
            `dedents onto a mapping level — all items of one sequence must share one indent column ` +
            `(run-32705244305 defect class: the workflow file stops parsing and every dispatch 422s)`);
          continue;
        }
      } else if (t && t.kind === "seq") {
        // deeper than the open sequence's item column: only legal as the
        // FIRST content of that sequence's bare current item
        const it = t.item;
        if (!it || it.contentColumn !== null) {
          const where = it && it.contentColumn !== null
            ? ` (item column ${t.indent}, content column ${it.contentColumn})` : "";
          err(no,
            `sequence item at column ${indent} matches no open scope${where} — ` +
            `a misindent between or beyond a sequence's columns is invalid block YAML`);
          continue;
        }
        it.contentColumn = indent;
        it.contentKind = "seq";
        stack.push({ indent, kind: "seq", line: no, item: itemFor(rest, inlineColumn) });
      } else if (t && t.kind === "map") {
        // deeper than a mapping: must hang off its empty-value key
        if (pendingKey && pendingKey.indent === t.indent && !pendingKey.hasValue) {
          stack.push({ indent, kind: "seq", line: no, item: itemFor(rest, inlineColumn) });
          pendingKey = { indent: t.indent, hasValue: true };
        } else {
          err(no, `sequence item at column ${indent} hangs off a mapping key that already has a value`);
          continue;
        }
      } else {
        // doc level: the document root must keep ONE column
        if (docRootColumn === null) docRootColumn = indent;
        else if (indent !== docRootColumn) {
          err(no, `sequence item at column ${indent} does not match the document root column ${docRootColumn}`);
          continue;
        }
        stack.push({ indent, kind: "seq", line: no, item: itemFor(rest, inlineColumn) });
      }
      // inline mapping content (`- key: value`) opens the item's map now
      const entry = top();
      if (entry && entry.kind === "seq" && entry.item && entry.item.contentKind === "map") {
        const [k, v] = entry.item.key;
        stack.push({ indent: entry.item.contentColumn, kind: "map", line: no });
        pendingKey = { indent: entry.item.contentColumn, hasValue: v !== null && v !== "" };
        if (v !== null && /^[|>]/.test(v.trim())) scalar = { keyIndent: entry.item.contentColumn, base: null, line: no };
      }
      continue;
    }

    // ---- mapping key line ----
    const [key, value] = kp;
    const trimmed = (value ?? "").trim();
    const hasValue = trimmed !== "" && !trimmed.startsWith("#");
    let t = top();
    if (t && t.kind === "seq" && t.indent === indent) {
      // a key at a sequence's item column closes that sequence and joins
      // the mapping below it — legal ONLY if that mapping owns the column
      stack.pop();
      t = top();
      if (!t || t.kind !== "map" || t.indent !== indent) {
        err(no, `mapping key '${key}' at column ${indent} closes a sequence but no mapping owns that column`);
        continue;
      }
    }
    if (!t || t.indent < indent) {
      if (t && t.kind === "map") {
        if (!(pendingKey && pendingKey.indent === t.indent && !pendingKey.hasValue)) {
          err(no, `mapping key '${key}' at column ${indent} nests under a key that already has a value`);
          continue;
        }
        stack.push({ indent, kind: "map", line: no });
      } else if (t && t.kind === "seq") {
        // deeper than the item column: only legal as the FIRST content of
        // the sequence's bare current item
        const it = t.item;
        if (!it || it.contentColumn !== null) {
          const where = it && it.contentColumn !== null
            ? ` (item column ${t.indent}, content column ${it.contentColumn})` : "";
          err(no, `mapping key '${key}' at column ${indent} matches no open scope${where}`);
          continue;
        }
        it.contentColumn = indent;
        it.contentKind = "map";
        stack.push({ indent, kind: "map", line: no });
      } else {
        // doc level: the document root must keep ONE column
        if (docRootColumn === null) docRootColumn = indent;
        else if (indent !== docRootColumn) {
          err(no, `mapping key '${key}' at column ${indent} does not match the document root column ${docRootColumn}`);
          continue;
        }
        stack.push({ indent, kind: "map", line: no });
      }
    }
    // (top map at the same column: sibling key — always fine)
    pendingKey = { indent, hasValue };
    lastPlainKey = hasValue && !/^[|>]/.test(trimmed) ? { indent } : null;
    if (hasValue && /^[|>]/.test(trimmed)) scalar = { keyIndent: indent, base: null, line: no };
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
