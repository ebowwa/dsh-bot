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
  rg's silent `-l`-wins); `context` must be a positive integer and is
  INCOMPATIBLE with `countOnly`/`filesOnly` (rg exits 0 and silently ignores
  `--context` next to `--count`/`--files-with-matches` — the same
  silently-ignored-parameter class, so it throws here before rg runs;
  PR #43 review r1 finding 2); `context`/`maxResults` garbage throws typed.

## What is verified where

- `tests/tool-search-compose.test.mjs` — the pure core: every compose flag,
  the total-cap semantics, both sort modes, every typed validation failure,
  and the package/overlay cross-file pins. It ALSO parse-checks the whole
  package (`node --check` over `lib/index.js` + `lib/compose.js`, JSON over
  `package.json`) — gates' syntax loop only walks `scripts/*`, and without
  this a syntax slip in the boot-time file would keep every gate green
  behind a "mounted" message (the dead-mount class; PR #43 review finding).
  Runs in gates (`node --test`), offline, no dsh packages needed.
- `tests/search-compose-mount.test.mjs` — the launcher: off = byte-identical
  launch line; on = copy + stamp + `--patch`; incomplete package fails loud.
  When the cell carries the real `dsh` CLI (the dsh lanes do), two
  skip-gated tests additionally prove the stamped overlay composes into the
  real profile (`--dump-config`) and that the packaged plugin's tree BOOTS
  against it — the live proof the stub-level tests cannot give.
