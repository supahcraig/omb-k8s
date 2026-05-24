Read CLAUDE.md and claude/ui-guidance.md fully before doing anything else.
Then read the existing frontend code in control-plane/ carefully before 
adding anything.

This is session 5 of 6. Your deliverable is the new and modified UI screens 
specified in claude/ui-guidance.md, built against the API endpoints implemented 
in session 4.

## What you are NOT changing

All existing screens: single run configuration, parameter sweep configuration, 
results table, sweep comparison, Prometheus visualization, websocket log 
streaming. Do not touch these unless strictly required.

## What you are building

Refer to claude/ui-guidance.md for full specifications. Summary:

1. Settings screen with two tabs:
   - Cluster Connectivity (BYOC and self-hosted modes)
   - Prometheus Configuration (BYOC and self-hosted modes)
   
2. Worker scaling control — persistent, always visible, not a separate screen

3. Workload Library screen — bundled (read-only) and custom (editable) workloads

## Implementation notes

- Build against the API endpoints specified in claude/ui-guidance.md. 
  If an endpoint behaves differently than specified, fix the backend, 
  not the frontend contract.
- The "Test Connection" button on cluster connectivity is important — 
  do not skip it or stub it out
- Worker scaling status must poll every 5 seconds (not websocket, simple polling)
- Do not allow run initiation when worker pods are not all ready — 
  this check happens in the UI before calling the run API
- Workload snapshot behavior (storing full YAML content in run record, 
  not a reference) is enforced in the backend — the frontend just needs 
  to send the workload content, not the ID, when initiating a run

## Validation

1. Settings screen renders, both modes work, Test Connection returns 
   success/failure with a human-readable message
2. Worker scaling control is visible on all screens, shows correct 
   ready/desired counts, Scale button updates replica count
3. Run initiation is blocked with a clear message when workers are not ready
4. Workload library shows bundled workloads, clone to custom works, 
   custom workloads can be edited and deleted
5. Selecting a workload from the library populates the run configuration form
6. All existing screens still work

Do not touch CI/CD or docs. That is session 6.
