# REVIEW.md — what review checks in this repo

Review rules for dsh-bot, applied by the dsh review stage (and any human).

## Correctness

- Shell scripts pass bash -n; node scripts pass node --check (gates enforces
  both — a review that skipped gates is invalid on its face).
- Workflow files pass `scripts/workflow-lint.mjs` (gates enforces it): a
  structurally invalid workflow — e.g. a step dedented out of its `steps:`
  sequence, the run-32705244305 class — parses nowhere and 422s every
  dispatch; it must never merge green again.
- Tests construct a lane-installed CLI's absence either with an explicit
  BIN seam (e.g. `DOPPLER_BIN=/nonexistent/…`) or with a fully hermetic
  PATH containing ONLY prepared shim dirs (runtime-interpolated, no
  system dir traversed, ambient PATH not re-included — the construction
  `tests/resolve-push-token.test.mjs` uses; blessed review r2 finding 5)
  — never by restricting PATH to a subset of system dirs: the dsh lanes
  install the real CLIs there, so the restriction constructs nothing —
  the test is green on a dev machine and takes the wrong branch on a
  lane (gates run 32933615526). `scripts/tests-lint.mjs` rejects the
  pattern (gates enforces it via the corpus test).
- Scrubbing is fail-closed: if the scrubber cannot run, the pipeline must
  abort rather than pass unscrubbed text onward. Any change that makes a
  scrub failure non-fatal is rejected.
- Secrets never appear in logs, comments, PR text, or workflow echoes.
  Env names must avoid KEY/PASSWORD/SECRET/TOKEN patterns in agent-visible
  contexts.
- Credentials never ride argv anywhere: a token passed as a git `-c`
  value, a curl `-H` header, or any command-line argument is rejected —
  argv is ps-readable to same-user processes on shared boxes. Env-based
  git config (`GIT_CONFIG_COUNT`), header-file curl config, and
  `.git/config` extraheaders are the sanctioned seams (this rule was
  earned on the resolve-push-token review rounds).

## Decoupled worker

- The worker scripts (`dsh-worker.sh`, `ship-changes.sh`, `post-reply.sh`,
  `review-pr.sh`) are shared with the CI flow where behavior overlaps; a
  change to one mode that silently drifts the other is a defect. Their env
  contracts must keep the DSH_*/GITHUB_* fallback shape so both callers
  work.
- Queue labels are NOT a trust mechanism: `dsh/queued` must only ever be
  acted on after the worker re-derives the trigger's trust from the
  comments API. A worker change that trusts the label alone is rejected.
- Reviews are queue items too (`dsh/review` via `agent-review-thin.yml`):
  this repo's own review path must not dispatch a runner-holding review
  workflow (`agent-review.yml` on `[self-hosted, dsh]`) — reviews run on
  the worker or in-session. Reintroducing a runner-holding review shell
  for dsh-bot itself is a defect.
- The worker review must never auto-approve: verdicts are label actions
  ONLY from `review-verdict.mjs`'s line-strict parse; an absent or
  unparseable verdict sets NO labels and must surface for a human. The
  rules contract is read from the PR's BASE ref — a PR must not be able to
  edit the REVIEW.md that grades it.

## Workflow discipline

- Workflows state their runner-lane impact in a comment when it changes.
- Reusable workflows run in the CALLER's context: caller's runners, token,
  secrets — anything consumed from the caller must be declared an input,
  never assumed present.
- Task/comment text reaches bash through env, never raw ${{ }} interpolation
  (injection seam — this repo fixed it once; do not reintroduce it).

## Honesty

- PR descriptions state what changed and what was NOT verified.
  Overstatement is a blocking defect, same as a bug.
- Failures surface as typed errors with context; no swallowed exits.
