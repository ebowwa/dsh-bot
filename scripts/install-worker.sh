#!/usr/bin/env bash
# install-worker.sh — one-shot, IDEMPOTENT worker deployment for a factory
# box. The deploy-worker.yml workflow calls this ON the box (the
# self-register-factory pattern: a workflow may install a persistent
# per-user service; cron keepalive needs no sudo).
#
# What it installs:
#   1. the toolkit checkout (clone if absent) at $DSH_BOT_INSTALL_DIR
#      (default ~/dsh-bot);
#   2. the worker env file (0600) at $DSH_WORKER_HOME/env (default
#      ~/.dsh-worker/env) — the ONLY place the credentials ever land
#      (never the cron line, never the log);
#   3. the cron keepalive line: every minute, pgrep-guard, RE-PIN the
#      toolkit to the moving `v1` tag (fetch --tags + checkout v1 — the
#      audited-release pin drift-check advances), source the env file,
#      run one sweep. The worker's code therefore updates itself only
#      through the repo's own release gate.
#
# Env contract (values via env; NEVER printed):
#   WORKER_GH_CRED          required — the worker PAT (BOT_PAT)
#   WORKER_DOPPLER_CRED     required — DOPPLER_SERVICE_TOKEN
#   WORKER_REPOS            required — DSH_WORKER_REPOS value
#                           (space-separated owner/repo list)
#   DSH_BOT_INSTALL_DIR     toolkit location (default $HOME/dsh-bot)
#   DSH_WORKER_HOME         worker home (default $HOME/.dsh-worker)
#
# Exit: 0 installed (or already installed); 2 missing env; 3 clone failed.

set -euo pipefail

CHECK() { # <varname> — required env, typed exit 2
  local v="$1"
  if [ -z "${!v:-}" ]; then echo "install-worker: $v unset (required)" >&2; exit 2; fi
}
CHECK WORKER_GH_CRED
CHECK WORKER_DOPPLER_CRED
CHECK WORKER_REPOS

DSH_BOT_DIR="${DSH_BOT_INSTALL_DIR:-$HOME/dsh-bot}"
WORKER_HOME="${DSH_WORKER_HOME:-$HOME/.dsh-worker}"

# 1. toolkit checkout (clone when absent) and ALWAYS refresh the pin to
#    the current v1 release — a deploy must run what steady-state runs
#    (the first activation ran a stale checkout and re-failed a fixed
#    bug). safe.directory is set explicitly: the Actions runner's per-job
#    HOME/gitconfig handling can trip git's ownership guard silently.
#    No -q: nothing in this installer may fail quietly.
PIN_OK=0
if [ ! -d "$DSH_BOT_DIR/.git" ]; then
  git clone https://github.com/ebowwa/dsh-bot.git "$DSH_BOT_DIR" \
    || { echo "install-worker: toolkit clone failed (egress?)" >&2; exit 3; }
fi
if git -c safe.directory="$DSH_BOT_DIR" -C "$DSH_BOT_DIR" fetch --tags --force \
   && git -c safe.directory="$DSH_BOT_DIR" -C "$DSH_BOT_DIR" checkout v1; then
  PIN_OK=1
  echo "install-worker: toolkit pinned at $(git -c safe.directory="$DSH_BOT_DIR" -C "$DSH_BOT_DIR" describe --tags 2>/dev/null || echo v1)"
else
  echo "install-worker: WARNING — could not refresh the pin to v1; the toolkit runs its previous checkout (cron retries each sweep)" >&2
fi

# 2. env file — umask 177 so the file is born 0600; values never echoed
mkdir -p "$WORKER_HOME"
chmod 700 "$WORKER_HOME"
( umask 177
  cat > "$WORKER_HOME/env" <<EOF
GH_TOKEN=${WORKER_GH_CRED}
DOPPLER_SERVICE_TOKEN=${WORKER_DOPPLER_CRED}
DSH_BOT_DIR="${DSH_BOT_DIR}"
DSH_WORKER_REPOS="${WORKER_REPOS}"
EOF
)
chmod 600 "$WORKER_HOME/env"
touch "$WORKER_HOME/worker.log" 2>/dev/null || true

# 3. cron keepalive — idempotent (skipped when the line exists). The
#    credentials are NOT in the line: it sources the 0600 env file.
#    `checkout v1` failing degrades to running the previously pinned
#    release (the fetch error lands in worker.log) — never a broken sweep.
# Overlap guard = flock, NOT pgrep. Every pgrep form self-matches here:
# the carrier sh -c's cmdline contains the REAL script path in the sweep
# braces, so the guard pattern always finds ITSELF (bracket tricks only
# protect the pattern's own text — live-proven twice on seed-dshbot:
# plain AND bracketed pgrep both never let a sweep run, worker.log empty
# for 25+ minutes). flock -n is the canonical cron mutual exclusion: if a
# sweep is running, this tick exits instantly; otherwise it runs.
command -v flock >/dev/null 2>&1 \
  || { echo "install-worker: flock (util-linux) required for the keepalive — provision the box" >&2; exit 3; }
# The sweep is invoked via `bash <script>` (NEVER directly): the repo
# ships scripts mode 644 — a direct invocation is "Permission denied"
# (live-proven: the keepalive fired every minute from 17:52 and died at
# exactly this word until fixed).
LINE="* * * * * flock -n ${WORKER_HOME}/sweep.lock /bin/bash -c 'git -C ${DSH_BOT_DIR} fetch --tags --force -q && git -C ${DSH_BOT_DIR} checkout -q v1 || true; set -a; . ${WORKER_HOME}/env; set +a; exec /bin/bash ${DSH_BOT_DIR}/scripts/dsh-worker.sh --once >> ${WORKER_HOME}/worker.log 2>&1'"
# The canonical-line rule: ALWAYS drop any existing dsh-worker line and
# install the current one. Append-only idempotence ships upgrades never
# (the box keeps its first, buggier line forever); rewrite-always is the
# upgrade path (two shipped lines already needed replacing: the
# self-matching pgrep, the tag-clobbering fetch).
if crontab -l 2>/dev/null | grep -F "dsh-worker.sh --once" >/dev/null 2>&1; then
  # grep -v exits 1 when the line was the ONLY crontab entry — expected,
  # not a failure (|| true on the GREP, never on the crontab write)
  { crontab -l 2>/dev/null | grep -vF "dsh-worker.sh --once" || true; } | crontab -
  echo "install-worker: previous keepalive line removed (canonical line enforced)"
fi
(crontab -l 2>/dev/null; echo "$LINE") | crontab - \
  || { echo "install-worker: crontab install failed" >&2; exit 3; }

echo "install-worker: OK"
echo "  toolkit : $DSH_BOT_DIR (pinned to the moving v1 tag per sweep)"
echo "  env     : $WORKER_HOME/env (mode 600) — the only credential resting place"
echo "  cron    : keepalive armed (pgrep-guarded, once per minute)"
echo "  repos   : $WORKER_REPOS"
echo "  watch   : $WORKER_HOME/worker.log"