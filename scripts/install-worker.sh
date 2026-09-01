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

# 1. toolkit checkout (clone once; the cron line keeps it pinned to v1)
if [ ! -d "$DSH_BOT_DIR/.git" ]; then
  git clone --quiet https://github.com/ebowwa/dsh-bot.git "$DSH_BOT_DIR" \
    || { echo "install-worker: toolkit clone failed (egress?)" >&2; exit 3; }
  git -C "$DSH_BOT_DIR" fetch --tags --quiet
  git -C "$DSH_BOT_DIR" checkout --quiet v1 \
    || echo "install-worker: v1 tag not resolvable yet — cron will pin on the first sweep" >&2
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
LINE="* * * * * pgrep -f 'dsh-worker.sh --once' >/dev/null 2>&1 || { git -C ${DSH_BOT_DIR} fetch --tags -q && git -C ${DSH_BOT_DIR} checkout -q v1 || true; set -a; . ${WORKER_HOME}/env; set +a; ${DSH_BOT_DIR}/scripts/dsh-worker.sh --once >> ${WORKER_HOME}/worker.log 2>&1; }"
if crontab -l 2>/dev/null | grep -F "dsh-worker.sh --once" >/dev/null; then
  echo "install-worker: cron keepalive already present — left untouched"
else
  (crontab -l 2>/dev/null; echo "$LINE") | crontab - \
    || { echo "install-worker: crontab install failed" >&2; exit 3; }
fi

echo "install-worker: OK"
echo "  toolkit : $DSH_BOT_DIR (pinned to the moving v1 tag per sweep)"
echo "  env     : $WORKER_HOME/env (mode 600) — the only credential resting place"
echo "  cron    : keepalive armed (pgrep-guarded, once per minute)"
echo "  repos   : $WORKER_REPOS"
echo "  watch   : $WORKER_HOME/worker.log"