#!/usr/bin/env node
// dsh-progress.mjs — render live dsh session events as Actions-log lines.
//
// Fed JSONL lines (a delta slice of session.jsonl.zstd) on stdin; the output
// goes ONLY to the GitHub Actions log. dsh itself is untouched: its stdout
// (the reply) and its session file are never modified by this renderer.
//
// Two line formats:
//
//   * model output (reasoning / assistant text / user message): ONE JSON
//     OBJECT PER LINE, full text, never truncated:
//       {"k":"reasoning","turn":1,"step":56,"text":"..."}
//       {"k":"assistant","turn":1,"step":57,"text":"..."}
//       {"k":"user","text":"..."}
//
//   * tool activity, kept in the existing human-readable shape, ASCII only:
//       tool: bash — command: cd cli/repositorytracker && bun test ...
//       result: 121 | test('branches --json lists the default branch'...
//
// Downstream: scrub-output.mjs (credential shapes / identifying metadata)
// runs after this in the same pipe. Stateless; re-run per poll slice.

process.stdout?.on?.("error", err => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

const TOOL_PREVIEW = 160;

const oneLine = s =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TOOL_PREVIEW);

const emitJson = obj => process.stdout.write(JSON.stringify(obj) + "\n");

function previewArguments(raw) {
  let args;
  try {
    args = JSON.parse(raw ?? "{}");
  } catch {
    return oneLine(raw);
  }
  for (const key of ["description", "command", "prompt", "file_path", "pattern", "query", "url", "content"]) {
    if (args[key] !== undefined && args[key] !== "") return `${key}: ${oneLine(args[key])}`;
  }
  const first = Object.keys(args)[0];
  return first ? `${first}: ${oneLine(args[first])}` : "";
}

import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  const t = evt.type;
  const d = evt.data ?? {};
  if (t === "tool/call") {
    process.stdout.write(`tool: ${d.name ?? "tool"} — ${previewArguments(d.arguments)}\n`);
  } else if (t === "tool/result") {
    const texts = d.message?.content ?? [];
    let out = "";
    for (const block of texts) {
      for (const part of block?.content ?? []) {
        if (part?.type === "text" && !out) out = part.text;
      }
    }
    process.stdout.write(`result: ${oneLine(out)}\n`);
  } else if (t === "reasoning-chunks") {
    const text = (d.texts ?? []).join("");
    if (text) emitJson({ k: "reasoning", turn: d.turn, step: d.step, text });
  } else if (t === "assistant/chunk") {
    const chunk = d.chunk;
    if (chunk?.type === "text" && String(chunk.text ?? "")) {
      emitJson({ k: "assistant", turn: d.turn, step: d.step, text: chunk.text });
    }
  } else if (t === "user/message") {
    // data.content is an array of parts: [{type:"text",text:"..."},...]
    let text = "";
    if (Array.isArray(d.content)) {
      text = d.content.filter(p => p?.type === "text").map(p => p.text ?? "").join("");
    } else if (typeof d.text === "string") {
      text = d.text;
    }
    if (text) emitJson({ k: "user", text });
  }
});
