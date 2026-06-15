# worker

OMB worker Dockerfile and entrypoint. This file supplements the root CLAUDE.md
with decisions specific to this directory.

## Design decisions — do not reverse without discussion

**JVM heap is computed from container memory at startup, not hardcoded.** Worker pod
container memory is driven by `worker.resources.memory` in the Helm values. At pod start,
`-XX:MaxRAMPercentage=75.0` combined with `-XX:+UseContainerSupport` causes the JVM to
read its cgroup memory limit and set heap = 75% of that value automatically. Do not add
`-Xms`/`-Xmx` fixed heap flags — they would override the percentage and break dynamic
sizing. Do not expose JVM heap percentage as a Helm value — 75% is correct for all OMB
worker workloads.

**The entrypoint calls java directly, not bin/benchmark-worker.** The upstream
bin/benchmark-worker script hardcodes HEAP_OPTS="-Xms4G -Xmx8G" and appends its
own GC flags, which would silently override the fixed JVM flags above. The
entrypoint invokes java directly with -cp lib/* to keep the specified flags
authoritative. Do not refactor the entrypoint to delegate to the bin scripts.

**Only driver-kafka, driver-redpanda, and driver-api JARs are included in the
worker image.** The OMB distribution bundles JARs for every driver (Pulsar,
RabbitMQ, Pravega, etc.). The Dockerfile strips all driver JARs except these
three. driver-api is the required interface that driver-kafka and driver-redpanda
both implement — it is not optional.

## Required JVM flags

Do not add `-Xms`/`-Xmx`. The full required flag set for the entrypoint:

```
-XX:InitialRAMPercentage=75.0
-XX:MaxRAMPercentage=75.0
-XX:+UseContainerSupport
-XX:+UseG1GC
-XX:MaxGCPauseMillis=10
-XX:+ParallelRefProcEnabled
-XX:+PerfDisableSharedMem
-XX:+DisableExplicitGC
-XX:MinHeapFreeRatio=10
-XX:MaxHeapFreeRatio=20
```

`-XX:+UseContainerSupport` causes the JVM to read cgroup memory limits. Combined with
`MaxRAMPercentage=75.0` this produces heap = 75% of container memory automatically.
`MinHeapFreeRatio=10` / `MaxHeapFreeRatio=20` causes G1GC to shrink the committed heap
back toward the live set after a large run completes, so worker memory charts reflect
actual usage rather than the high-water mark from a prior run.
