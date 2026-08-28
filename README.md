# dsh-bot

The reusable agent-loop toolkit: comment-triggered `/dsh` coding agents
(DeepSeek Harness headless + GLM via Z.AI/Doppler), adversarial review
stage, deterministic shipper, and enforced output/input scrubbing — as
**reusable workflows** (`workflow_call`) that consumer repos adopt with
~15-line event shells.

Runs in the **caller's context**: your runners, your `GITHUB_TOKEN`, your
secrets. This repo needs no runners of its own.

## What's shared here

| File | Purpose |
|---|---|
| `.github/workflows/agent-comment.yml` | the comment loop: context fetch → scrub → agent → ship → reply → review dispatch |
| `.github/workflows/agent-review.yml` | adversarial review stage (rules + gates + verdict + labels) |
| `.github/workflows/agent-dispatch.yml` | manual/scheduled task entry |
| `scripts/run-dsh-agent.sh` | driver: dsh install, settings bootstrap, gh/git identity, scrub shims, live trace, Doppler exec; head model via `DSH_MODEL`, subagent/subagent_fork children via `DSH_SUBAGENT_MODEL` (unset = inherit the head); local web search + fetch via `DSH_WEB_SEARCH_CELLS` (per-cell, default off) |
| `scripts/scrub-output.mjs` | redaction (creds/PII/SSH keys in both directions; IP/host/path/date on outputs) |
| `scripts/gh-scrub-shim`, `git-scrub-shim` | the scrubber BETWEEN agent and GitHub/git |
| `scripts/dsh-progress.mjs` | live JSON trace of reasoning/tool events |
| `scripts/workflow-lint.mjs` | structural workflow-YAML lint (block-indent consistency; gates runs it — run 32705244305 regression) |
| `scripts/tests-lint.mjs` | structural test-source lint: rejects PATH assignments that hard-code system dirs without the ambient PATH — they cannot construct a lane-installed CLI's absence (run 32933615526 regression; the corpus test rides `node --test`) |
| `config/settings.zai.yaml` | DSH settings template (zai provider, glm-5.3) |
| `consumers.txt` | repos receiving drift bump-PRs |

## Adopting (consumer repo)

1. Runners labeled `dsh` (optionally `big`), secret `DOPPLER_SERVICE_TOKEN`
   (Doppler config holding `ZAI_API_KEY`), runner PATH with `node gh doppler`.
2. Three thin shells in `.github/workflows/` — see `examples/` for
   copy-paste versions.
3. Write your own `REVIEW.md` (the review contract is repo-specific).

## Versioning

Consumers pin `@v1` (moving major tag). Breaking changes bump the major.
Scrubber/security fixes land as minors and reach consumers only through a
drift-check bump PR merged by each repo's own gates + review — the audit
gate. Nothing propagates silently.

## Local web search + fetch (per-cell, default off)

The launcher can mount [`@local/dsh-web-search-browser`](https://github.com/ebowwa/HelloMacOScreator/tree/main/web-search-browser)
— a key-free `ctx.web` provider that searches free engine result pages and
fetches arbitrary URLs via the cell's own headless Chromium — as a
regenerated `--patch` overlay, exactly like the subagent-model stamp:

- `DSH_WEB_SEARCH_CELLS` (workflow input `web-search-browser-cells`) — a
  comma-separated list of runner names. The provider mounts ONLY when the
  job's `RUNNER_NAME` is listed; unset/empty is off on every cell. This is
  the per-cell adoption gate: a runner name is earned by provisioning the
  cell (a complete plugin copy at `DSH_WEB_SEARCH_BROWSER_PATH`, default
  `~/.dsh/profiles/node_modules/@local/dsh-web-search-browser`) and passing
  its live smoke (one search + one fetch through the provider on that
  machine). A listed runner without its copy fails loud — a plugin that
  cannot resolve is a dead mount, never a working one.
- `DSH_WEB_SEARCH_BROWSER_BROWSERS` — optional space-separated browser
  binary paths pinned into the provider row. Some CI cells have no working
  full-browser new-headless session (the render hangs with no DOM) while
  the standalone `chrome-headless-shell` binary works; the provider's
  `browsers` config is the supported seam for that.

The overlay restates the bundle's `web` row (`searchProvider:
headless-browser`) and `tool-web` row (`fetch: true`, 60s budgets) — patch
rows replace whole plugin config — and inserts the provider row through the
loader's `insert:` grammar (a bare row whose id is unknown only warns and
is silently skipped). No API key is involved anywhere; search and fetch
both run locally on the cell.
