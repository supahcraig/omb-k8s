#!/usr/bin/env bash
set -euo pipefail

# Fixed JVM flags — not configurable. See CLAUDE.md for rationale.
# Scaling is horizontal (more worker pods), not vertical.
# Calling java directly (not bin/benchmark-worker) so these flags are
# authoritative and not overridden by HEAP_OPTS in the upstream script.
JVM_OPTS="\
-XX:InitialRAMPercentage=75.0 \
-XX:MaxRAMPercentage=75.0 \
-XX:+UseContainerSupport \
-XX:+UseG1GC \
-XX:MaxGCPauseMillis=10 \
-XX:+ParallelRefProcEnabled \
-XX:+PerfDisableSharedMem \
-XX:+DisableExplicitGC \
-XX:MinHeapFreeRatio=10 \
-XX:MaxHeapFreeRatio=20"

# Forward SIGTERM to the child process and wait for clean exit.
# Required for graceful Kubernetes pod termination.
_term() {
  if [[ -n "${child:-}" ]]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
}
trap _term SIGTERM SIGINT

# shellcheck disable=SC2086
case "${OMB_MODE:-worker}" in
  worker)
    java -server $JVM_OPTS -cp "lib/*" \
      io.openmessaging.benchmark.worker.BenchmarkWorker --port "${OMB_WORKER_PORT:-9080}" &
    child=$!
    wait "$child"
    ;;
  driver)
    exec java -server $JVM_OPTS -cp "lib/*" \
      io.openmessaging.benchmark.Benchmark "$@"
    ;;
  *)
    echo "ERROR: OMB_MODE must be 'worker' or 'driver', got: '${OMB_MODE}'" >&2
    exit 1
    ;;
esac
