# tool-search-compose

The composition search tool: one `search` call covering the pipe shapes the
fleet kept reaching for bash to get — counts (`-c`), file lists (`-l`),
case-folding (`-i`), context lines, a **total** result cap (`| head`), and
path/mtime ordering (`| sort`). Wraps the same packaged ripgrep the fs-search
tools use, argv elements only.

## Why the plugin is a package (the f2972e7 blocker)

The first mount attempt (reverted at f2972e7) pointed the overlay at this
directory's bare in-tree path. Two independent failures, both packaging:

1. A bare path resolves relative to the **profile directory** at boot — the
   file is not there, and nothing beside it can satisfy the plugin's bare
   `@deepseek-ai/*` imports anyway (no `node_modules` in a script checkout).
2. The `defineTool` call was missing the required `output` block, which the
   harness rejects at registration even once imports resolve.

The fix is the same shape the `@local/dsh-web-search-browser` mount uses
(PR #37): the plugin ships as a real package and the launcher copies it into
the profile module tree, where the harness's own packages are the flat
fallback it resolves against.

## Mount contract (scripts/run-dsh-agent.sh)

`DSH_SEARCH_COMPOSE=1` before `run-dsh-agent.sh` runs. Default **off** —
opt-in per caller, never a silent fleet-wide flip (same posture as the web
provider). When set, the launcher, on every run:

1. checks the package is complete here (`package.json` + `lib/index.js`;
   missing pieces fail loud — a plugin that cannot resolve is a dead mount,
   never a working one),
2. copies it to `$DSH_HOME/profiles/node_modules/@dsh-bot/tool-search-compose`,
3. stamps a regenerated `$DSH_HOME/search-compose.patch.yml` overlay whose
   row is an explicit `insert:` (a bare row with an unknown id only warns and
   is silently skipped — the silently-dead patch the insert grammar exists to
   prevent), then passes it via `--patch`.

The overlay names the **package**, never a path. Deps resolve positionally:
`@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-tool-fs-search` sit in the
profile tree's flat fallback, hoisted there by the dsh install — no extra
provisioning per cell (unlike the web provider, nothing here is per-cell:
no browser, no smoke binary).

## Honest-parameter notes (issue #40)

- `maxResults` is a total cap over the run's result lines, applied after the
  search. ripgrep has no total-cap flag (`--max-count` is per file and
  over-reports by the file count); the cap lives in `lib/compose.js`.
- `sortedBy` delegates to rg `--sort=path|modified` — file ordering with
  within-file match order preserved. Sorting output lines string-wise (the
  previous behavior for `path`) scrambles `file:10:` before `file:9:`.
  Unknown values throw; nothing is silently ignored.
- `countOnly` and `filesOnly` are mutually exclusive (throwing, not
  rg's silent `-l`-wins); `context`/`maxResults` must be positive integers.

## What is verified where

- `tests/tool-search-compose.test.mjs` — the pure core: every compose flag,
  the total-cap semantics, both sort modes, every typed validation failure,
  and the package/overlay cross-file pins. Runs in gates (`node --test`),
  offline, no dsh packages needed.
- `tests/search-compose-mount.test.mjs` — the launcher: off = byte-identical
  launch line; on = copy + stamp + `--patch`; incomplete package fails loud.
- Verified once against the real harness during development (dsh
  0.1.0-rc.7): the copied package loads at boot and resolves both
  `@deepseek-ai` imports from the profile tree, and the registered tool's
  `execute` was driven end-to-end against real ripgrep. Gates cannot run
  that live path (no dsh runtime in this repo); the first live boot on a
  lane is the remaining unverified step — same adoption posture as the web
  provider before its cell smoke.
