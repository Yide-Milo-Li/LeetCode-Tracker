#!/usr/bin/env bash
# macOS / POSIX Source-Mode Desktop Launcher for LeetCode Tracker.
# Probes loopback port for an existing instance, checks for port conflicts,
# ensures frontend build assets exist, launches the Fastify server, awaits
# readiness up to 15s, opens the default browser, and forwards shutdown signals.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "====================================================="
echo "       LeetCode Tracker - Desktop Launcher           "
echo "====================================================="

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not found in PATH." >&2
  echo "Please install Node.js 24.x from https://nodejs.org/" >&2
  exit 1
fi

if [ -z "${PORT:-}" ]; then
  PORT="$(node -e "
    if (typeof process.loadEnvFile === 'function') {
      try { process.loadEnvFile(); } catch {}
    }
    process.stdout.write(process.env.PORT || '3000');
  ")"
fi

case "$PORT" in
  ''|*[!0-9]*)
    echo "Error: Invalid PORT '$PORT'. Expected an integer between 1 and 65535." >&2
    exit 1
    ;;
esac

if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Error: PORT '$PORT' is out of range (1-65535)." >&2
  exit 1
fi

export PORT
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}"
STATS_URL="${URL}/api/v1/catalog/stats"

open_browser() {
  local target="$1"
  if [ -x /usr/bin/open ]; then
    /usr/bin/open "$target"
  elif command -v open >/dev/null 2>&1; then
    open "$target"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$target" >/dev/null 2>&1 &
  else
    echo "Please open this URL in your browser: $target"
  fi
}

probe_stats() {
  if command -v curl >/dev/null 2>&1; then
    local body
    body="$(curl -fsS --max-time 1 "$STATS_URL" 2>/dev/null || true)"
    if [ -n "$body" ] && printf '%s' "$body" | grep -q '"totalProblems"'; then
      return 0
    fi
    return 1
  fi

  node -e "
    fetch(process.argv[1], { signal: AbortSignal.timeout(1000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => process.exit(data && typeof data === 'object' && 'totalProblems' in data ? 0 : 1))
      .catch(() => process.exit(1));
  " "$STATS_URL"
}

check_port_occupied() {
  if command -v lsof >/dev/null 2>&1; then
    local lsof_out
    lsof_out="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$lsof_out" ]; then
      echo "Error: Port $PORT is already occupied by another process:" >&2
      echo "$lsof_out" >&2
      echo "Please stop that process or set a custom PORT (e.g., PORT=3001)." >&2
      return 0
    fi
  fi

  if ! node -e "
    const net = require('node:net');
    const port = Number(process.argv[1]);
    const host = process.argv[2];
    const srv = net.createServer();
    srv.once('error', (err) => process.exit(err && err.code === 'EADDRINUSE' ? 2 : 1));
    srv.once('listening', () => srv.close(() => process.exit(0)));
    srv.listen(port, host);
  " "$PORT" "$HOST"; then
    echo "Error: Port $PORT on $HOST is currently occupied by another process." >&2
    echo "Please stop that process or set a custom PORT (e.g., PORT=3001)." >&2
    return 0
  fi

  return 1
}

# 1. Check if LeetCode Tracker is already running on target port
if probe_stats; then
  echo "LeetCode Tracker is already running on ${URL}."
  echo "Opening default browser..."
  open_browser "$URL"
  exit 0
fi

# 2. Abort cleanly if another service holds the port
if check_port_occupied; then
  exit 1
fi

# 3. Ensure frontend production bundle exists
if [ ! -f "$REPO_ROOT/apps/web/dist/index.html" ]; then
  echo "Frontend build assets missing. Running npm run build..."
  if ! npm run build; then
    echo "Build failed. Please fix build errors before launching." >&2
    exit 1
  fi
fi

# 4. Launch Fastify server and manage lifecycle
SERVER_PID=""
SHUTTING_DOWN=0

cleanup_on_exit() {
  local exit_code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}

forward_signal() {
  local sig="$1"
  SHUTTING_DOWN=1
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo ""
    echo "[Stopping server process ($sig)...]"
    kill "-$sig" "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  trap - EXIT INT TERM
  exit 0
}

trap cleanup_on_exit EXIT
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM

echo "Starting LeetCode Tracker server on ${URL}..."
node apps/server/src/server.ts &
SERVER_PID=$!

# 5. Poll /api/v1/catalog/stats up to 15 seconds (30 x 500ms)
printf "Waiting for local service readiness"
READY=0
ATTEMPT=0
MAX_ATTEMPTS=30

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ] && [ "$SHUTTING_DOWN" -eq 0 ]; do
  sleep 0.5 &
  wait $! 2>/dev/null || true

  if [ "$SHUTTING_DOWN" -ne 0 ]; then
    break
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    SERVER_EXIT=0
    wait "$SERVER_PID" || SERVER_EXIT=$?
    SERVER_PID=""
    echo ""
    echo "Server process exited prematurely with exit code ${SERVER_EXIT}." >&2
    exit "${SERVER_EXIT:-1}"
  fi

  ATTEMPT=$((ATTEMPT + 1))
  printf "."

  if probe_stats; then
    READY=1
    break
  fi
done

echo ""

if [ "$SHUTTING_DOWN" -ne 0 ]; then
  exit 0
fi

if [ "$READY" -eq 1 ]; then
  echo "LeetCode Tracker is ready!"
  echo "  Web: ${URL}/"
  echo "  API: ${STATS_URL}"
  echo "Opening default browser..."
  open_browser "$URL"
  echo ""
  echo "[Server is running. Press Ctrl+C to stop cleanly]"
  echo ""
else
  echo "Warning: Health check timed out after 15s, but server process is still running."
  echo "Opening browser anyway: ${URL}"
  open_browser "$URL"
fi

SERVER_EXIT=0
wait "$SERVER_PID" || SERVER_EXIT=$?
SERVER_PID=""
exit "$SERVER_EXIT"
