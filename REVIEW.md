# REVIEW.md — what review checks in this repo

Review rules for dsh-bot, applied by the dsh review stage (and any human).

## Correctness

- Shell scripts pass bash -n; node scripts pass node --check (gates enforces
  both — a review that skipped gates is invalid on its face).
- Workflow files pass `scripts/workflow-lint.mjs` (gates enforces it): a
  structurally invalid workflow — e.g. a step dedented out of its `steps:`
  sequence, the run-32705244305 class — parses nowhere and 422s every
  dispatch; it must never merge green again.
- Tests construct a lane-installed CLI's absence with an explicit BIN seam
  (e.g. `DOPPLER_BIN=/nonexistent/…`), never by restricting PATH to system
  dirs: the dsh lanes install the real CLIs there, so the restriction
  constructs nothing — the test is green on a dev machine and takes the
  wrong branch on a lane (gates run 32933615526). `scripts/tests-lint.mjs`
  rejects the pattern (gates enforces it via the corpus test).
- Scrubbing is fail-closed: if the scrubber cannot run, the pipeline must
  abort rather than pass unscrubbed text onward. Any change that makes a
  scrub failure non-fatal is rejected.
- Secrets never appear in logs, comments, PR text, or workflow echoes.
  Env names must avoid KEY/PASSWORD/SECRET/TOKEN patterns in agent-visible
  contexts.

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
