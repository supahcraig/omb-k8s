# Scaling Workers Mid-Engagement

When you need more throughput, add more worker pods. This guide covers how to
scale workers up and down safely without disrupting an ongoing engagement.

---

## The right mental model

- **More pods = more throughput.** All worker pods are identical: 4 vCPU / 8 GB,
  heap set to 75% of container memory automatically.
- **Horizontal only.** The correct response to a throughput ceiling is more pods,
  not bigger instances.
- **Scale via the UI only** — see below for why kubectl is the wrong tool here.

---

## Scaling up via the UI

1. Find the **worker scaling control** in the bottom of the left sidebar:
   `Workers` label · readiness badge · replica count input · **Scale** button.
2. Enter the new replica count and click **Scale**.
3. Watch the readiness badge — it will show how many pods are ready vs. desired.

**What happens next:**

| Phase | Duration | What you see |
|-------|----------|--------------|
| Pod creation | A few seconds | New pods appear in ClusterPage |
| JVM startup | ~15–30 s | Pods are Running but not yet ready |
| Ready | After JVM init | Green indicator in sidebar and ClusterPage |

Wait for all pods to show green before launching a benchmark. The control plane
constructs the `--workers` argument from the current replica count at job
creation time — unhealthy pods included in the list will cause the run to fail.

### If a node fills up

Each benchmark-worker node fits roughly 8 worker pods before it is full. When
you scale beyond node capacity:

1. New pods enter **Pending** state — visible on the ClusterPage.
2. The Cluster Autoscaler detects the pending pods and provisions a new node.
3. Node startup takes **~2–3 minutes on AWS**, faster on GCP and Azure.
4. Once the node is ready, pods transition to Running, then to ready.

You can watch this progress on the **OMB Cluster** page in the UI. No action is
needed — autoscaling is fully automatic.

---

## Scaling down via the UI

1. **Do not scale down while a benchmark is running.** Cancel or wait for
   completion first.
2. Enter the lower replica count in the sidebar scaling control and click **Scale**.
3. StatefulSet pods terminate in reverse order: `omb-worker-2` before
   `omb-worker-1`, and so on.

Nodes that become empty after a scale-down are reclaimed by the Cluster
Autoscaler after a short idle window (~10 minutes by default).

---

## Unhealthy worker pods

The **OMB Cluster** page shows a red health dot next to any worker that is
unreachable. This can happen after a cancelled run leaves the worker's internal
Java process in a stuck state.

- Click the **↺** restart button on the affected pod row.
- The StatefulSet controller recreates the pod immediately.
- Wait for the green indicator before running another benchmark.

---

## What NOT to do

> These actions will either break the current engagement or require a full
> cluster teardown and rebuild.

- **Do not use `kubectl scale` to change the StatefulSet directly.** The control
  plane tracks the replica count and constructs the `--workers` list from it. If
  you bypass the UI, the control plane's view of the cluster drifts from reality
  and subsequent runs will reference the wrong set of workers.

- **Do not change instance types mid-engagement.** Worker node instance types are
  set in Terraform. Changing them requires `terraform apply`, which recreates the
  node pool and tears down all running pods.

- **Do not modify JVM settings** (`-Xms`, `-Xmx`, `-XX:MaxRAMPercentage`, etc.).
  These are baked into the worker image. There is no mechanism to override them
  at runtime, and changing them would require rebuilding and pushing a new image.

- **Do not edit the Helm chart resource limits/requests for worker pods
  mid-engagement.** This requires a `helm upgrade`, which restarts all worker pods.

---

## Quick reference

| Action | Where |
|--------|-------|
| Scale workers up or down | Sidebar scaling control (bottom of left nav) |
| Check pod readiness | Sidebar badge or OMB Cluster page |
| Restart a stuck worker | OMB Cluster page → ↺ button |
| Watch autoscaler provision a node | OMB Cluster page (pod status) |
