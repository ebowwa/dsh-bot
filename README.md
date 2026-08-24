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
| `scripts/run-dsh-agent.sh` | driver: dsh install, settings bootstrap, gh/git identity, scrub shims, live trace, Doppler exec |
| `scripts/scrub-output.mjs` | redaction (creds/PII/SSH keys in both directions; IP/host/path/date on outputs) |
| `scripts/gh-scrub-shim`, `git-scrub-shim` | the scrubber BETWEEN agent and GitHub/git |
| `scripts/dsh-progress.mjs` | live JSON trace of reasoning/tool events |
| `scripts/workflow-lint.mjs` | structural workflow-YAML lint (block-indent consistency; gates runs it — run 32705244305 regression) |
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
