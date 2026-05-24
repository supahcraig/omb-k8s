# Session 4 — Control Plane Migration

Read CLAUDE.md and claude/ui-guidance.md fully before doing anything else.
Then read https://github.com/supahcraig/omb_ui carefully — understand the
existing codebase before changing anything. Do not make assumptions about
what it does; read the actual code.

This is session 4 of 6. Your deliverable is the migrated control plane in
control-plane/ with all backend changes implemented and working against the
cluster and Helm chart from sessions 2 and 3.

## What you are migrating

The existing omb_ui FastAPI + React application. All existing functionality
must continue to work after migration:
- Single run configuration and launch
- Parameter sweep configuration and launch
- Results table and visualization
- Sweep comparison
- Prometheus metrics visualization
- Websocket log streaming

Do not redesign existing screens or change existing API contracts unless
strictly required by the migration.

## Backend changes required

### omb_runner.py — replace subprocess with k8s Job

Current behavior: calls subprocess.run("bin/benchmark --drivers ... --workers ...")
New behavior: creates a k8s Job using the kubernetes Python client

Job creation steps:
1. Read driver config and workload config text from SQLite
2. Create a ConfigMap in the release namespace containing:
     driver.yaml: <driver config text>
     workload.yaml: <workload config text>
   Name the ConfigMap: omb-run-<run-id>
3. Construct the --workers argument by iterating 0..(replica_count-1):
     http://omb-worker-{i}.omb-worker.<namespace>.svc.cluster.local:8080
   Namespace comes from env var OMB_NAMESPACE
   Replica count comes from querying the StatefulSet via k8s API
4. Create a Job based on the driver-job template pattern from the Helm chart
   (charts/omb/templates/jobs/driver-job.yaml). The Job:
   - Mounts the ConfigMap at /etc/omb/
   - Runs: bin/benchmark --drivers /etc/omb/driver.yaml
             /etc/omb/workload.yaml --workers <constructed list>
   - Uses the worker image with OMB_MODE=driver
   - Has restart policy Never
   - Has ttlSecondsAfterFinished: 300
5. Watch the Job via k8s API and stream logs back via the existing
   websocket mechanism
6. On Job completion (success or failure), delete the ConfigMap
7. Parse results from Job logs as before

Use in-cluster config exclusively:
  kubernetes.config.load_incluster_config()
Do not reference kubeconfig files. Do not use load_kube_config().

Add the kubernetes Python package to requirements.txt.

### yaml_io.py — replace disk with SQLite

Current behavior: reads/writes YAML files to disk under OMB_DIR
New behavior: stores YAML content as text in SQLite

Add a workloads table to the existing SQLAlchemy models:

  class Workload(Base):
      __tablename__ = "workloads"
      id = Column(String, primary_key=True, default=lambda: str(uuid4()))
      name = Column(String, nullable=False)
      description = Column(String, nullable=True)
      content = Column(Text, nullable=False)       # full YAML content
      is_bundled = Column(Boolean, default=False)
      cloned_from_id = Column(String, ForeignKey("workloads.id"), nullable=True)
      created_at = Column(DateTime, default=datetime.utcnow)
      updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
      last_used_at = Column(DateTime, nullable=True)
      last_used_run_id = Column(String, ForeignKey("runs.id"), nullable=True)

When a run is created, store a full snapshot of the YAML content in the run
record — not a reference to the workload ID. Historical run records must be
immutable with respect to workload edits or deletions.

Add a settings table:

  class Setting(Base):
      __tablename__ = "settings"
      key = Column(String, primary_key=True)
      value = Column(Text, nullable=False)

### SQLite file path

Read from env var OMB_DB_PATH, default /data/omb_ui.db
The /data path matches the PVC mount defined in the Helm chart.

### New API endpoints

Implement all endpoints specified in claude/ui-guidance.md exactly as
specified, including request/response schemas. The frontend in session 5
will be built against these contracts.

### Settings persistence and application

Cluster connectivity config and Prometheus config are stored in the settings
table in SQLite. On control plane startup:
1. Load settings from DB
2. If Prometheus config exists, write it to the Prometheus ConfigMap and
   trigger a reload

Prometheus ConfigMap name: omb-prometheus-config
Verify this matches what the kube-prometheus-stack subchart expects for
additional scrape configs — check the subchart documentation before
hardcoding this name.

SASL passwords and Prometheus remote write passwords must be stored encrypted
at rest. Use Fernet symmetric encryption (cryptography package). Store the
encryption key as a k8s Secret mounted into the control plane pod. Never
return password values in GET /api/settings responses.

### Bundled workload seeding

On control plane startup, if no bundled workloads exist in the DB, seed from
workload YAML files bundled in the image at /app/workloads/.

Copy the Kafka/Redpanda-relevant workload examples from:
https://github.com/redpanda-data/openmessaging-benchmark/tree/main/driver-redpanda/deploy/workloads

into control-plane/workloads/ and include them in the Docker image.
Only include workloads relevant to Kafka/Redpanda benchmarking — exclude
anything Pulsar, RabbitMQ, or otherwise non-Kafka.

Parse each YAML file to extract name and key parameters for the description
field (message size, partition count, target rate where present).

## Dockerfile for control plane

Base image: python:3.11-slim

Contents:
- FastAPI application and all Python dependencies from requirements.txt
- Built React frontend served as static files by FastAPI
  (build output copied from control-plane/frontend/build/ or dist/)
- OMB benchmark binary and Redpanda driver files
  (copy from the worker image using a multi-stage build)
- Bundled workload YAML files at /app/workloads/

Env vars with defaults:
  OMB_DB_PATH=/data/omb_ui.db
  OMB_NAMESPACE=default
  PORT=8000

## Validation

Deploy to the cluster from sessions 2 and 3 and verify:

1. Control plane pod starts without errors:
   kubectl logs -f <control-plane-pod>

2. Existing screens load and function correctly in the browser:
   - Single run configuration form renders
   - Parameter sweep configuration renders
   - Results table renders (may be empty)

3. A benchmark run can be submitted end to end:
   - k8s Job appears after clicking Run: kubectl get jobs
   - Logs stream back to the UI via websocket
   - Job completes and results are saved to SQLite

4. Results survive a pod restart:
   kubectl delete pod <control-plane-pod>
   (wait for restart)
   Verify results are still present in the UI

5. Worker status endpoint returns correct data:
   curl http://<loadbalancer>/api/workers/status

6. Workload library endpoint returns bundled workloads:
   curl http://<loadbalancer>/api/workloads

Do not build new UI screens. That is session 5.
