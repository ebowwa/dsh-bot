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

/** Does body look like `key:` / `key: value`? Returns [key, value|null].
 * Quote- and comment-aware: a colon inside quotes or a trailing comment
 * does not open a key, and keys starting with a YAML indicator character
 * (& * ! % @ ` ?) or containing quotes are not workflow keys — otherwise
 * scalar-body debris dedented out of its block slides through as
 * structure (review findings on PR #11, rounds 3–4). */
const keyParts = (body) => {
  let q = null;
  let keyEnd = -1;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") {
      // a quoted segment BEFORE any key colon: not a plain workflow key
      if (keyEnd < 0) return null;
      q = c;
      continue;
    }
    // a comment (space-#) before any top-level colon: no key on this line
    if (c === "#" && j > 0 && (body[j - 1] === " " || body[j - 1] === "\t")) return null;
    if (c === ":" && (j === body.length - 1 || body[j + 1] === " " || body[j + 1] === "\t")) {
      keyEnd = j;
      break;
    }
  }
  if (keyEnd <= 0) return null;
  const key = body.slice(0, keyEnd);
  // keys starting with a flow/indicator character (or a leading ':') are
  // scalar debris, not workflow keys — workflow keys are identifiers
  if (/^[&*!%@`?:,[\]{}]/.test(key)) return null;
  const value = body.slice(keyEnd + 1).trim();
  return [key, value === "" ? null : value];
};

/** Net bracket depth of a line, ignoring quoted segments ([{ = +1, ]} = -1). */
const netBrackets = (s) => {
  let n = 0;
  let q = null;
  for (const c of s) {
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") n++;
    else if (c === "]" || c === "}") n--;
  }
  return n;
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
  // Open flow-collection depth: lines inside a multi-line [..] or {..}
  // (or after an unbalanced opener) are flow content, not block structure.
  let flowDepth = 0;

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

    // Block-scalar handling: the first non-blank content line fixes `base`
    // — and MUST sit strictly deeper than the header key's column. A first
    // line at/below the key column means either an empty scalar (legal,
    // and the line is structural) or a body dedented to/past its key (the
    // uniform re-indent accident, review finding on PR #11) — the line
    // falls through and classification tells them apart. Blank lines and
    // lines at >= base are content. Any other dedent ends the scalar and
    // re-enters structural processing (a real parser rejects the file).
    let scalarBreakKey = null;
    if (scalar) {
      if (body === "") continue;
      if (scalar.base === null) {
        if (indent > scalar.keyIndent) {
          scalar.base = indent;
          continue;
        }
        scalarBreakKey = scalar.keyIndent;
        scalar = null; // this line re-enters normal processing below
      } else if (indent >= scalar.base) continue;
      else scalar = null; // this line re-enters normal processing below
    }

    if (body === "") continue;
    if (body.startsWith("#")) continue;
    if (body === "---" || body === "...") { // document markers reset scope
      stack = [];
      pendingKey = null;
      docRootColumn = null;
      lastPlainKey = null;
      flowDepth = 0;
      continue;
    }
    if (/^\s*\t/.test(raw)) {
      err(no, "tab indentation (YAML requires spaces)");
      continue;
    }

    // multi-line flow collections ([..] / {..}): content until balanced
    if (flowDepth > 0) {
      flowDepth += netBrackets(body);
      continue;
    }

    const seqMatch = /^-(?:\s+(.*))?$/.exec(body);
    const kp = seqMatch ? null : keyParts(body);
    if (!seqMatch && !kp) {
      if (scalarBreakKey !== null) {
        err(no,
          `block scalar content at column ${indent} is not deeper than its key at column ` +
          `${scalarBreakKey} — invalid block YAML (the whole body dedented to/past its key)`);
        continue;
      }
      // plain multi-line scalar continuation (review finding on PR #11):
      // `key: value` folds across deeper lines that are not keys
      if (lastPlainKey && indent > lastPlainKey.indent) continue;
      // a value-less key's plain scalar value, written on the next line
      // (`runs-on:\n  ubuntu-latest`) — legal; fills the key's slot
      if (pendingKey && !pendingKey.hasValue && indent > pendingKey.indent) {
        pendingKey.hasValue = true;
        lastPlainKey = { indent: pendingKey.indent };
        continue;
      }
      err(no, `line is neither a mapping key nor a sequence item: '${body.slice(0, 40)}'`);
      continue;
    }
    // an unbalanced opener starts a flow collection consumed above
    const openFlow = netBrackets(body);
    if (openFlow > 0) {
      flowDepth = openFlow;
      lastPlainKey = null;
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
