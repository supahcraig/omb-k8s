# UI Design Guidance

The existing UI screens (single run, parameter sweep, results, sweep comparison,
Prometheus visualization, websocket log streaming) are not being redesigned.
Do not change them unless a change is strictly required by the backend migration.

Read https://github.com/supahcraig/omb_ui carefully before writing any frontend
code. Understand what exists before adding anything new.

## General principles

- Clarity over cleverness — used by SEs during live customer engagements where
  confusion is costly
- All screens must work at 1280px wide minimum — SEs are not on large monitors
  during customer calls
- Error states must be explicit and human-readable. Wrap OMB and k8s errors in
  plain English with a suggested remediation where possible. "Connection refused"
  is not an acceptable error message to surface to an SE mid-engagement.
- Loading states required on any action that takes more than 500ms — spinners
  or progress indicators throughout
- Worker scaling status and active run status must be visible without scrolling
  on the main screen at all times — these are the two things an SE watches
  during a benchmark session

## New screen: Settings — Cluster Connectivity

This is the most important screen to get right. A misconfigured broker address
is the most likely reason a benchmark fails to start, and OMB's error messages
when it can't reach brokers are not user-friendly.

Two modes selectable via a clearly labeled toggle or tab:

### BYOC mode

- Single bootstrap server field (hostname:port)
- TLS: always on — do not show as a configurable toggle
- SASL mechanism: always SCRAM-SHA-256 — do not show as a configurable dropdown
- SASL username field
- SASL password field (masked)
- "Test Connection" button — attempts to reach the broker and reports success
  or failure with a human-readable message. An SE must be able to verify
  connectivity before attempting a run. Do not stub this out.

### Self-hosted mode

- Seed brokers field — comma-separated hostname:port list
- Helper text: "Enter one or more seed brokers, e.g. broker-1:9092,broker-2:9092"
- TLS toggle (on/off)
- SASL toggle (on/off)
  - When on: mechanism dropdown (SCRAM-SHA-256, SCRAM-SHA-512, PLAIN)
  - Username field
  - Password field (masked)
- Same "Test Connection" button as BYOC mode

Settings are persisted in SQLite and loaded on control plane startup.
Never written to disk as a file.

## New screen: Settings — Prometheus Configuration

Second tab on the Settings screen, directly adjacent to Cluster Connectivity.

### BYOC mode

- Remote write URL field
- Username field
- Password field (masked)
- Helper text explaining where to find these values in the Redpanda Cloud UI

### Self-hosted mode

- Scrape targets field — comma-separated hostname:port list
- Helper text: "Typically the same hosts as your seed brokers on the Prometheus
  metrics port (default 9644 for Redpanda)"

"Save & Apply" button writes config to the Prometheus ConfigMap and triggers
a reload. Show an explicit success/failure indicator — do not silently fail.

## Worker scaling control

Not a separate screen. Lives as a persistent element in the main navigation
or sidebar — always visible regardless of which screen the SE is on.

Contents:
- Current replica count (live, polling StatefulSet status every 5 seconds —
  use simple polling, not websocket)
- Desired replica count input (number spinner, min 1, max 20)
- "Scale" button
- Pod readiness indicator: "N/M ready" where N is ready pods and M is desired
  e.g. "3/4 ready"

Critical behavior:
- Do not allow launching a run when desired != ready
- Show a clear blocking warning: "Waiting for workers: 2/4 ready.
  Please wait before starting a run."
- Once all pods are ready the warning clears and run initiation is re-enabled

## New screen: Workload Library

Two clearly labeled sections on the same screen:

### Bundled workloads

Read-only. Seeded from OMB repo canonical examples at deploy time.

Each entry displays:
- Name
- Description
- Key parameters at a glance: message size, partition count, target rate

Actions per entry:
- "Use" button — loads workload directly into the run configuration form
- "Clone to Custom" button — copies it into the custom section for editing

Bundled workloads cannot be edited or deleted. Do not show edit/delete controls.

### Custom workloads

User-created or cloned-from-bundled workloads.

Each entry displays the same fields as bundled workloads plus:
- Last modified date
- Last run that used it (if applicable)

Actions per entry:
- "Use" button — loads into run configuration form
- Edit button — opens inline or modal editor for name, description, YAML content
- Delete button — with confirmation prompt

### Critical behavior — workload snapshots

When a workload is loaded into a run and that run is executed, the run record
in SQLite stores a full snapshot of the YAML content at the time of the run —
not a reference to the workload ID.

This means:
- Editing a custom workload after a run does not retroactively change that
  run's historical record
- Deleting a workload does not affect historical run records
- The run history is a complete and accurate record of exactly what was run

This behavior is enforced in the backend. The frontend sends workload content
(not workload ID) when initiating a run.

## Backend API endpoints required for new UI features

Build the frontend against these contracts exactly. If an endpoint behaves
differently than specified, fix the backend to match, not the frontend.

### Worker status and scaling

GET /api/workers/status
Returns:
{
  "desired": int,
  "ready": int,
  "pods": [
    { "name": str, "status": str }
  ]
}

POST /api/workers/scale
Body: { "replicas": int }
Returns: { "desired": int }

### Workload library

GET /api/workloads
Returns:
{
  "bundled": [Workload],
  "custom": [Workload]
}

Workload schema:
{
  "id": str,
  "name": str,
  "description": str | null,
  "content": str,          // full YAML content
  "is_bundled": bool,
  "cloned_from_id": str | null,
  "created_at": str,       // ISO 8601
  "updated_at": str,       // ISO 8601
  "last_used_at": str | null,
  "last_used_run_id": str | null
}

POST /api/workloads
Body: { "name": str, "content": str, "cloned_from_id": str | null }
Returns: Workload

PUT /api/workloads/{id}
Body: { "name": str, "description": str | null, "content": str }
Returns: Workload

DELETE /api/workloads/{id}
Returns: 204 No Content

### Settings

GET /api/settings
Returns:
{
  "cluster": ClusterConfig,
  "prometheus": PrometheusConfig
}

PUT /api/settings
Body: { "cluster": ClusterConfig, "prometheus": PrometheusConfig }
Returns: { "cluster": ClusterConfig, "prometheus": PrometheusConfig }

POST /api/settings/test-connection
Returns: { "success": bool, "message": str }
// message must be human-readable in both success and failure cases
// e.g. "Successfully connected to broker at rpk-xyz.us-east-1.byoc.prd.cloud.redpanda.com:9092"
// e.g. "Could not reach broker: connection timed out. Check that VPC peering is active and the bootstrap address is correct."

ClusterConfig schema:
{
  "mode": "byoc" | "self-hosted",
  "bootstrap_servers": str,    // single for BYOC, comma-separated for self-hosted
  "tls_enabled": bool,         // always true for BYOC, shown in schema for completeness
  "sasl_enabled": bool,        // always true for BYOC
  "sasl_mechanism": str | null, // SCRAM-SHA-256 | SCRAM-SHA-512 | PLAIN
  "sasl_username": str | null,
  "sasl_password": str | null  // stored encrypted at rest, never returned in GET
}

PrometheusConfig schema:
{
  "mode": "byoc" | "self-hosted",
  "remote_write_url": str | null,   // BYOC
  "remote_write_username": str | null,
  "remote_write_password": str | null, // stored encrypted at rest, never returned in GET
  "scrape_targets": str | null      // self-hosted, comma-separated hostname:port
}
