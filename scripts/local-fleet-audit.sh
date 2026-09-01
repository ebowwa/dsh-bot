#!/usr/bin/env bash
# local-fleet-audit.sh — the LOCAL plane of any occupancy audit.
#
# Why this exists (the air-native-linux incident, 2026-08-31 → 09-01): a
# LaunchAgent on a laptop claimed tower lane tickets for ~30 hours while
# every cloud-side audit showed nothing — no Actions runs, no queue, no
# factory box. The participant was under the auditor's own shell the
# whole time. The perimeter rule this encodes: an occupancy audit covers
# processes, service managers, and dsh/node artifacts ON THE MACHINE IT
# RUNS ON — not just GitHub.
#
# Report-only: findings are printed loudly, exit stays 0 (an audit that
# fails CI teaches people to stop running it). Run it on ANY machine that
# might be participating — laptops included, especially your own.
#
# Checks:
#   1. live processes matching dsh/node participant patterns
#   2. service managers: launchd (mac), systemd --user (linux), cron
#   3. filesystem: ~/dsh-* dirs, ~/.dsh-worker, dsh/node LaunchAgents,
#      and the installed worker keepalive (crontab + sweep.lock)
#
# Env: HOME (default ~). No network, no mutations.

set -uo pipefail

AUDIT_HOME="${HOME:-$PWD}"
FINDINGS=0

note() { echo "local-fleet-audit: $*"; }
found() { FINDINGS=$((FINDINGS + 1)); echo ">> FINDING: $*" >&2; }

note "auditing the local plane under $AUDIT_HOME ($(uname -s) $(uname -m))"

# --- 1. live processes ------------------------------------------------------
note "--- processes (dsh/node participants) ---"
# self-excluded: this audit's own bash would match the dsh-bot/scripts pattern
PROCS="$(ps aux 2>/dev/null | grep -iE 'dsh-(node|worker)|dsh-bot/scripts|actions-runner' | grep -v grep | grep -v local-fleet-audit || true)"
if [ -n "$PROCS" ]; then
  printf '%s\n' "$PROCS" | cut -c1-160
  found "live participant processes (above)"
else
  note "none"
fi

# --- 2. service managers ----------------------------------------------------
note "--- launchd (mac) ---"
if command -v launchctl >/dev/null 2>&1; then
  LA="$(launchctl list 2>/dev/null | grep -iE 'dsh|node|gh-tracker' || true)"
  if [ -n "$LA" ]; then printf '%s\n' "$LA"; found "launchd services (above)"; else note "none"; fi
else
  note "launchctl absent (not mac)"
fi

note "--- systemd --user (linux) ---"
if command -v systemctl >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1; then
  SU="$(systemctl --user list-units --all --no-legend 2>/dev/null | grep -iE 'dsh|node' || true)"
  if [ -n "$SU" ]; then printf '%s\n' "$SU"; found "systemd user units (above)"; else note "none"; fi
else
  note "systemd --user unavailable"
fi

note "--- cron ---"
if command -v crontab >/dev/null 2>&1; then
  CR="$(crontab -l 2>/dev/null | grep -iE 'dsh|worker|flock.*sweep' || true)"
  if [ -n "$CR" ]; then printf '%s\n' "$CR"; found "cron entries (above)"; else note "none"; fi
else
  note "crontab absent"
fi

# --- 3. filesystem ----------------------------------------------------------
note "--- filesystem artifacts ---"
for d in "$AUDIT_HOME"/dsh-* "$AUDIT_HOME"/.dsh-worker "$AUDIT_HOME"/factory-runner; do
  [ -d "$d" ] || continue
  found "directory: $d"
done
if [ -d "$AUDIT_HOME/Library/LaunchAgents" ]; then
  for p in "$AUDIT_HOME"/Library/LaunchAgents/*.plist; do
    [ -f "$p" ] || continue
    case "$p" in *dsh*|*node*|*gh-tracker*) found "LaunchAgent plist: $p"; printf '   quarantined: %s\n' "$([ -f "$AUDIT_HOME/Library/LaunchAgents/disabled/$(basename "$p")" ] && echo yes || echo no)";; esac
  done
fi
if [ -e "$AUDIT_HOME/.dsh-worker/env" ]; then
  note "worker env present (~/.dsh-worker/env — this machine IS a worker)"
  [ -e "$AUDIT_HOME/.dsh-worker/sweep.lock" ] && note "worker keepalive lock present (sweeps have run here)"
fi

# --- summary -----------------------------------------------------------------
if [ "$FINDINGS" -gt 0 ]; then
  note "RESULT: $FINDINGS finding(s) — this machine is (or was) a fleet participant. Verify each is sanctioned."
else
  note "RESULT: clean — no local fleet participation detected."
fi
exit 0