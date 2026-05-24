Read CLAUDE.md and claude/ui-guidance.md fully before doing anything else.
Then read https://github.com/supahcraig/omb_ui carefully — understand what 
exists before changing anything.

This is session 4 of 6. Your deliverable is the migrated control plane in 
control-plane/ with all backend changes implemented.

## What you are migrating

The existing omb_ui FastAPI + React application. The existing functionality 
(single runs, parameter sweeps, results, sweep comparison, Prometheus 
visualization, websocket log streaming) must continue to work. Do not 
redesign existing screens or change existing behavior unless required by 
the migration.

## Backend changes required

### omb_runner.py — replace subprocess with k8s Job

Current behavior: calls subprocess.run("bin/benchmark --drivers ... --workers ...")
New behavior: creates a k8s Job using the kubernetes Python client

Job creation steps:
1. Read driver config and workload config text from SQLite
2. Create a ConfigMap containing driver.yaml and workload.yaml as data keys
3. Construct the --workers argument by iterating 0..(replica_count-1):
   http://omb-worker-{i}.omb-worker.<namespace>.svc.cluster.local:8080
   Namespace comes from env var OMB_NAMESPACE (injected by Helm)
   Replica count comes from querying the StatefulSet via k8s API
4. Create a Job using the driver-job template pattern from the Helm chart
   Job mounts the ConfigMap at /etc/omb/
   Job runs: bin/benchmark --drivers /etc/omb/driver.yaml 
             /etc/omb/workload.yaml --workers <constructed list>
   Job image: same worker image (OMB_MODE=driver)
5. Watch the Job via k8s API, stream logs back via existing websocket mechanism
6. On Job completion, clean up the ConfigMap
7. Parse results from Job logs as before

Use in-cluster config (kubernetes.config.load_incluster_config()) — do not 
reference kubeconfig files.

Add kubernetes Python package to requirements.txt.

### yaml_io.py — replace disk with SQLite

Current behavior: reads/writes YAML files to disk under OMB_DIR
New behavior: stores YAML content as text in SQLite

Add a workloads table to the existing SQLAlchemy models:
- id (primary key)
- name (string)
- description (string, nullable)  
- content (text — full YAML content)
- is_bundled (boolean — true for seeded workloads, false for user-created)
- cloned_from_id (foreign key to self, nullable)
- created_at (datetime)
- updated_at (datetime)
- last_used_at (datetime, nullable)
- last_used_run_id (foreign key to runs, nullable)

When a run is created, store a snapshot of the full YAML content in the run 
record — not a reference to the workload ID. Historical run records must not 
be affected by subsequent workload edits.

### SQLite file path

Read from env var OMB_DB_PATH, default /data/omb_ui.db
The /data path matches the PVC mount point defined in the Helm chart.

### New API endpoints

Implement the endpoints specified in claude/ui-guidance.md exactly as specified.

### Settings persistence

Cluster connectivity config and Prometheus config stored in a settings table 
in SQLite (key-value or structured, your choice). Loaded on startup and 
applied to the Prometheus ConfigMap on startup if Prometheus config exists.

Prometheus ConfigMap name: omb-prometheus-config (must match what the 
kube-prometheus-stack subchart expects for additional scrape configs — 
verify this against the subchart documentation).

### Bundled workload seeding

On control plane startup, if the bundled workloads table is empty, seed it 
from workload YAML files bundled into the control plane image.

Copy the Kafka/Redpanda-relevant workload examples from 
https://github.com/redpanda-data/openmessaging-benchmark/tree/main/driver-redpanda/deploy/workloads
into control-plane/workloads/ and include them in the Docker image.

Only include workloads that make sense for Redpanda/Kafka benchmarking.

## Dockerfile for control plane

Base image: python:3.11-slim

Contents:
- FastAPI application
- Built React frontend (served as static files by FastAPI)
- OMB benchmark binary and Redpanda driver (copied from worker image or 
  built separately — your choice, but justify it)
- Bundled workload YAML files at /app/workloads/
- All Python dependencies from requirements.txt

Env vars with defaults:
- OMB_DB_PATH=/data/omb_ui.db
- OMB_NAMESPACE=default
- PORT=8000

## Validation

1. Control plane starts without errors in the k8s cluster from session 3
2. Existing screens load and function (single run, sweeps, results)
3. A benchmark run can be submitted, the k8s Job appears, logs stream back
4. Results are saved to SQLite on the PV and survive a pod restart
5. /api/workers/status returns correct replica count
6. /api/workloads returns bundled workloads

Do not build the new UI screens. That is session 5.
