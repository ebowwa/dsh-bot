#!/usr/bin/env node
// scrub-output.mjs — redact secrets (and, in full mode, identifying metadata).
//
// Two modes:
//   default        — output surfaces (Actions-log trace, reply comments):
//                    credentials + IPs/hostnames/home paths redacted.
//   SECRETS_ONLY=1 — model-input surfaces (task text, thread context):
//                    credentials redacted; paths/IPs/hosts are KEPT, since a
//                    task may legitimately reference them but a pasted key
//                    never is. This mode guards what is sent to the provider.
//
// Reads stdin, writes scrubbed stdout. Deliberately over-broad: a false
// [redacted] costs nothing; a leaked key costs everything.

process.stdout?.on?.("error", err => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @type {[RegExp, string, "secret" | "meta"][]} */
const rules = [];

// Layer 1 — exact values present in this process env (works when scrubbing in
// the same environment that holds the secret). Always credential-kind.
for (const name of ["ZAI_API_KEY", "DOPPLER_SERVICE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
  const v = process.env[name];
  if (v && v.length > 8) rules.push([new RegExp(escapeRe(v), "g"), `[redacted:${name}]`, "secret"]);
}

// Layer 2 — shapes. Credential shapes are "secret" (redacted in BOTH modes);
// identifying metadata is "meta" (default mode only).
rules.push(
  [/\b[0-9a-f]{32}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted:key]", "secret"], // Z.AI-style
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted:key]", "secret"], // OpenAI/gateway style
  [/\bdp\.[a-z]{2}\.[A-Za-z0-9_.-]{16,}/g, "[redacted:token]", "secret"], // Doppler dp.st.<cfg>.<slug>
  [/\bgh[posr]_[A-Za-z0-9]{20,}\b/g, "[redacted:token]", "secret"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted:token]", "secret"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted:jwt]", "secret"],
  [/[Bb]earer\s+[A-Za-z0-9._-]{16,}/g, "Bearer [redacted]", "secret"],
  // PII: SSN shapes (never task-legitimate; redacted in BOTH modes — a real
  // SSN reaching the provider is as bad as a key reaching it)
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted:ssn]", "secret"],
  // SSH public keys (authorized_keys lines) — credential material, both modes
  [/\b(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]{20,}(={0,3})(?: [\w@.-]+)?/g, "[redacted:ssh-key]", "secret"],
  // SSH / TLS / PEM private key blocks (header to footer, incl. newlines)
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[redacted:private-key]", "secret"],
  // Bare base64 SSH key bodies (public keys pasted without the prefix)
  [/\bAAAA[A-Za-z0-9+/]{40,}={0,3}\b/g, "[redacted:ssh-key]", "secret"],
  // ---- identifying metadata: output surfaces only ----
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[redacted:ip]", "meta"], // public or private
  [/\b[\w-]+\.local\b/g, "[redacted:host]", "meta"],
  // Extra hostnames to redact come from the CONSUMER (private repo) via env,
  // so this shared (public-safe) file never names real machines:
  //   DSH_SCRUB_EXTRA_HOSTS="host1,host2" (comma-separated)
  ...(() => {
    const raw = process.env.DSH_SCRUB_EXTRA_HOSTS ?? "";
    const hosts = raw.split(",").map(h => h.trim()).filter(h => h.length > 2);
    if (hosts.length === 0) return [];
    return [[new RegExp(`\\b(?:${hosts.map(escapeRe).join("|")})\\b`, "g"), "[redacted:host]", "meta"]];
  })(),
  [/(?:^|(?<=[\s"'=(<`]))\/(?:Users|home|root)\/[^\s"',)<>`]+/g, "[redacted:path]", "meta"],
  // Dates — meta tier: redacted on output surfaces (timestamps can correlate
  // runs to a person's working hours); KEPT in model input (tasks legitimately
  // reference dates constantly, and ISO dates alone rarely identify anyone).
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?\b/g, "[redacted:date]", "meta"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "[redacted:date]", "meta"],
);

const active = process.env.SECRETS_ONLY === "1" ? rules.filter(r => r[2] === "secret") : rules;

import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const out = [];
rl.on("line", line => {
  for (const [re, rep] of active) line = line.replace(re, rep);
  out.push(line);
});
rl.on("close", () => process.stdout.write(out.join("\n") + "\n"));
