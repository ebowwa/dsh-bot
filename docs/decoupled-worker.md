# Decoupled mode — thin trigger + out-of-band worker

The comment-triggered agent loop no longer needs to execute inside the
Actions job that holds a self-hosted runner for up to 120 minutes. In
decoupled mode the **trigger** is a ~20-second github-hosted job and the
**agent actually runs on an always-on worker process** on the factory pool
boxes. Consumers keep only a ~15-line shell; the worker runs the headless
agent, ships, replies, and reviews.

```
consumer repo                          factory box (always-on)
┌───────────────────────────┐          ┌───────────────────────────────┐
│ /dsh comment on issue/PR  │          │  dsh-worker.sh --loop/cron    │
│   │                       │          │   poll repos for dsh/queued   │
│   ▼                       │          │   claim (delete queued label) │
│ shell (trust gate)        │          │   checkout PR merge ref       │
│   │                       │          │   run-dsh-agent.sh (driver)   │
│   ▼                       │          │   ship-changes.sh (shipper)   │
│ agent-comment-thin.yml    │◄─────────│   post-reply.sh (ack edit)    │
│  ack comment (dsh:ack)    │  API     │   review-pr.sh (adversarial)  │
│  add label dsh/queued     │          └───────────────────────────────┘
│  → job exits, ~20s        │
└───────────────────────────┘
```

## What the consumer does (recommended adoption)

One file, `.github/workflows/dsh-agent-thin.yml` — copy
`examples/dsh-agent-thin.yml`. It keeps the existing trust gate
(author-association + not-a-bot) and calls the reusable
`agent-comment-thin.yml` trigger, which runs on **github-hosted
ubuntu-latest** and only acks + enqueues. No self-hosted `dsh` runners, no
`DOPPLER_SERVICE_TOKEN`, no `DSH_BOT_REPO_TOKEN` are required anymore.

## Queue semantics (labels, no new infra)

| label | meaning |
|---|---|
| `dsh/queued` | added by the trigger; pending |
| `dsh/running` | claimed — the worker DELETE-removed `queued` (a second worker racing the same item gets a 404 on the DELETE and skips it) |
| `dsh/review` | a REVIEW-ONLY item — added by `agent-review-thin.yml` (a `/review` comment or `workflow_dispatch`); the worker claims it the same way and runs `review-pr.sh` on that PR. **The decoupled review stage: reviews of ANY PR run on the worker — no Actions job holds a runner for a review, ever.** |
| (removed at completion) | `running` is removed; a fresher `queued` from a newer trigger comment stays queued for the next sweep |

The queue list is read with the issues REST API (`gh api repos/R/issues?labels=...`)
per configured repo — no search-index lag, PRs included. Same-thread
serialization matches the CI flow: the worker takes the **last** trusted
`/dsh` comment as the task, and the **last** ack comment (matched by the
`dsh:ack` marker) is edited in place — one living comment per task.

## Installing the worker on a factory box

**The one-dispatch path (recommended):** fire the `deploy-worker` workflow
(workflow_dispatch, input `repos` = the DSH_WORKER_REPOS list). It runs
`scripts/install-worker.sh` ON a dsh box — the self-register-factory
pattern — and installs everything below idempotently: credentials from the
repo's `BOT_PAT` + `DOPPLER_SERVICE_TOKEN` secrets land ONLY in the 0600
env file, and the cron line re-pins the toolkit to the moving `v1` tag
every sweep, so the worker's code updates exclusively through
drift-check's audited releases.

The manual equivalent (what the installer automates; cron keepalive needs
no sudo, `svc.sh`/systemd when sudo exists — issue #6):

```bash
# 1. toolkit checkout (keep updated: git pull — or via the drift bump PR)
git clone --depth 1 https://github.com/ebowwa/dsh-bot "$HOME/dsh-bot"

# 2. worker env — secrets live ONLY here, 0600:
cp "$HOME/dsh-bot/config/dsh-worker.env.example" "$HOME/.dsh-worker/env"
chmod 600 "$HOME/.dsh-worker/env"
#   edit: GH_TOKEN, DOPPLER_SERVICE_TOKEN (REQUIRED — the agent launches
#   only via `doppler run --token ...`; the driver fails typed, exit 2,
#   without it), DSH_WORKER_REPOS

# 3a. systemd (the box has passwordless sudo — the issue #6 path):
#     sudo ~/factory-runner/svc.sh install && sudo ~/factory-runner/svc.sh start
#     (or a unit running: bash -c 'set -a; . $HOME/.dsh-worker/env; set +a; \
#      exec $HOME/dsh-bot/scripts/dsh-worker.sh --loop')

# 3b. cron keepalive, one line — starts within 60s, self-heals after
#     reboots and job-cleanup kills (the pattern factory-runner proves):
#     * * * * * pgrep -f 'dsh-worker.sh --once' >/dev/null || { set -a; . $HOME/.dsh-worker/env; set +a; $HOME/dsh-bot/scripts/dsh-worker.sh --once >> $HOME/.dsh-worker/worker.log 2>&1; }
```

The cron line and unit must NOT contain tokens — only the 0600 env file
does.

## Trust model (double gate)

1. The consumer shell gates at event time (author-association, not a bot)
   before the trigger even runs.
2. The worker re-derives the same trust from the comments API before
   touching a task. An untrusted `/dsh` comment is never acted on; a thread
   with no trusted trigger gets a short reply and the item is closed.

## Security posture — the honest delta vs. CI

The cost of decoupling is that **the worker holds credentials between
tasks** (a long-lived `GH_TOKEN` + optional Doppler token). What limits the
blast radius:

- **Per task, nothing persists**: the driver's existing per-job `DSH_HOME`
  (inside the run dir's tmp) is removed at exit; session transcripts are
  deleted; run dirs are pruned (`DSH_WORKER_KEEP_RUNS`).
- **No token on argv**: git auth rides env-based git config for the clone
  and the `.git/config` extraheader written by `resolve-push-token.sh` for
  pushes — the same discipline the CI flow uses.
- **Least privilege**: `DSH_WORKER_REPOS` is the only scope the worker
  touches; one PAT per consumer (or one worker per consumer) is the
  recommended deployment.
- **Review never auto-approves**: `review-pr.sh` posts a comment and sets
  `ai-reviewed`/`changes-requested` ONLY from a line-strict verdict
  (`scripts/review-verdict.mjs`); an absent/unparseable verdict sets no
  labels and tells a human to look.
- **Reviews are queue items too**: `/review` on a PR (or a
  `workflow_dispatch`) enqueues `dsh/review` via `agent-review-thin.yml` —
  a ~15s github-hosted job. The review itself always runs on the worker.
  dsh-bot's own `dsh-review.yml` uses this path (dogfood).
- **Scrubbing unchanged and fail-closed**: model-input scrubbing
  (`SECRETS_ONLY=1`) guards what reaches the provider; output scrubbing
  guards the reply/PR/review surfaces; a scrubber failure withholds output.

Known weaker spot (accepted): reviewer and shipper run on the same worker
host — adversarial separation is process-level, not machine-level as in the
CI flow's separate workflow runs. Consumers who need hard isolation keep the
legacy `agent-review.yml`/`dsh-review.yml` path.

## Migration window

`agent-comment.yml`, `agent-dispatch.yml`, `agent-review.yml` and the old
example shells stay in tree, marked LEGACY, fully functional. Consumers
flip by adopting the thin shell (drift-check bump PRs carry the change).
The legacy path is removed at the next major version bump. Workers upstream
to consumers through the same `@v1` moving tag + drift gates as everything
else here.

## Operational notes

- **Observability**: per-task progress is visible on the thread (the ack
  comment is edited at ship/reply time) and in
  `~/.dsh-worker/worker.log` + run dirs under
  `~/.dsh-worker/runs/`. There is no Actions-run URL in decoupled mode —
  the ack comment and worker log replace it.
- **Timeout**: `DSH_WORKER_TIMEOUT_MIN` (default 120) is enforced via GNU
  `timeout` on Linux boxes; without `timeout` the worker warns once and
  runs uncapped.
- **Concurrency**: `--once` processes every queued item sequentially;
  multiple boxes each running `--once` on the same repos share the queue
  safely via the claim DELETE. `--loop` is for single-processor service
  mode; when used, ensure only one loop per box (`pgrep` guard in cron).