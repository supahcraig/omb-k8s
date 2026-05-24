# Session 5 — UI Changes

Read CLAUDE.md and claude/ui-guidance.md fully before doing anything else.
Then read the existing frontend code in control-plane/ carefully before
adding anything new.

This is session 5 of 6. Your deliverable is the new and modified UI screens
specified in claude/ui-guidance.md, built against the API endpoints
implemented in session 4.

## What you are NOT changing

All existing screens must continue to work exactly as before:
- Single run configuration and launch
- Parameter sweep configuration and launch
- Results table and visualization
- Sweep comparison
- Prometheus metrics visualization
- Websocket log streaming

Do not touch these unless strictly required. If an existing screen breaks
during this session, fix it before moving on.

## What you are building

Refer to claude/ui-guidance.md for full specifications. This is a summary
only — the spec in ui-guidance.md is authoritative.

### 1. Settings screen — two tabs

Tab 1: Cluster Connectivity
- BYOC mode and self-hosted mode, switchable via toggle or tab
- See ui-guidance.md for full field specifications per mode
- "Test Connection" button is required — do not stub it out or skip it
- Settings persisted via PUT /api/settings
- Loaded on page open via GET /api/settings

Tab 2: Prometheus Configuration
- BYOC mode and self-hosted mode matching the cluster connectivity mode
- "Save & Apply" button with explicit success/failure feedback
- See ui-guidance.md for full field specifications

### 2. Worker scaling control — persistent, always visible

This is not a screen. It is a persistent component visible on every screen,
in the navigation or sidebar.

- Current replica count polled every 5 seconds via GET /api/workers/status
- Use simple polling, not websocket
- Desired replica count input (number spinner, min 1, max 20)
- Scale button calls POST /api/workers/scale
- Readiness indicator: "N/M ready"
- Run initiation must be blocked when desired != ready with a clear message:
  "Waiting for workers: N/M ready. Please wait before starting a run."
- This blocking check must be enforced in the UI before calling the run API,
  not just in the backend

### 3. Workload Library screen

Two sections: Bundled (read-only) and Custom (editable).
See ui-guidance.md for full specifications including:
- Display fields per workload entry
- Action buttons per section
- Clone to Custom behavior
- Edit and delete for custom workloads

Critical: when initiating a run from a workload, send the full YAML content
to the run API — not the workload ID. This is how the backend stores a
snapshot. Do not send a reference.

## Implementation notes

- Build against the API endpoints in claude/ui-guidance.md exactly as
  specified. If an endpoint behaves differently than specified, fix the
  backend to match the spec rather than working around it in the frontend.
- Password fields must never display stored values on load — show a
  placeholder (e.g. "••••••••") indicating a value is saved, with a
  "Change" affordance to enter a new one
- The Test Connection button on cluster connectivity must show a loading
  state while the request is in flight — it may take several seconds
- All new screens must work at 1280px wide minimum
- Error messages from the backend must be surfaced in plain English —
  do not show raw API error responses or stack traces to the user

## Validation

1. Settings screen renders correctly in both BYOC and self-hosted modes
2. Test Connection returns a human-readable success or failure message
3. Prometheus config saves and the "Save & Apply" success indicator works
4. Worker scaling control is visible on all screens including existing ones
5. Worker scaling control shows correct ready/desired counts
6. Scale button updates replica count and the readiness indicator updates
7. Run initiation is blocked with a clear message when workers are not ready
8. Run initiation proceeds normally when all workers are ready
9. Workload Library shows bundled workloads with correct display fields
10. Clone to Custom creates an editable copy in the custom section
11. Custom workloads can be edited and deleted
12. Selecting a workload via Use populates the run configuration form
13. All existing screens still work correctly

Do not touch CI/CD or documentation. That is session 6.
