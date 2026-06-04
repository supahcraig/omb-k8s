# Grafana — LoadBalancer + Redpanda Dashboard

Read CLAUDE.md fully before doing anything else.
Read charts/omb/values.yaml and charts/omb/Chart.yaml carefully before
making any changes — understand the current kube-prometheus-stack
subchart configuration before touching it.

This is a focused change to the Helm chart only. Do not touch Terraform,
the control plane code, CI/CD, or any other component.

---

## Deliverables

1. Expose Grafana via a LoadBalancer Service
2. Configure a non-default admin password
3. Pre-provision the official Redpanda Grafana dashboard automatically

---

## Grafana Service

Grafana is currently deployed as part of the kube-prometheus-stack subchart.
Find the existing Grafana service configuration in values.yaml and update it
to use LoadBalancer:

```yaml
kube-prometheus-stack:
  grafana:
    service:
      type: LoadBalancer
    adminPassword: changeme
```

The adminPassword must be surfaced as an overridable Helm value so SEs can
set their own password at install/upgrade time:

```bash
helm upgrade omb charts/omb -n omb \
  -f charts/omb/values-aws.yaml \
  --set kube-prometheus-stack.grafana.adminPassword=my-secure-password
```

Add a prominent comment in values.yaml next to adminPassword:
  # IMPORTANT: always override this before deploying in customer engagements
  # helm install/upgrade ... --set kube-prometheus-stack.grafana.adminPassword=<password>

Do NOT hardcode a secure password in values.yaml — changeme is intentionally
obvious so it gets overridden.

---

## Redpanda Grafana dashboard

Verify the current Redpanda official dashboard ID before implementing.
Check https://grafana.com/grafana/dashboards/?search=redpanda for the
current official Redpanda dashboard. The expected ID is 15353 but confirm
this is current and use the correct ID.

Provision the dashboard automatically via the Grafana sidecar pattern so
it appears immediately after helm install without any manual import:

```yaml
kube-prometheus-stack:
  grafana:
    sidecar:
      dashboards:
        enabled: true
    dashboardProviders:
      dashboardproviders.yaml:
        apiVersion: 1
        providers:
        - name: redpanda
          orgId: 1
          folder: Redpanda
          type: file
          disableDeletion: false
          editable: true
          options:
            path: /var/lib/grafana/dashboards/redpanda
    dashboards:
      redpanda:
        redpanda-dashboard:
          url: https://grafana.com/api/dashboards/15353/revisions/latest/download
          datasource: Prometheus
```

If the URL-based approach is unreliable (network access issues from within
the cluster are common), fall back to bundling the dashboard JSON directly:
- Download the dashboard JSON from Grafana.com
- Save it to charts/omb/dashboards/redpanda.json
- Create a ConfigMap from it and mount it into Grafana via the sidecar

The bundled JSON approach is more reliable for air-gapped or restricted
environments and is preferred if there is any doubt about network access.

---

## Prometheus stays internal

Do not change the Prometheus Service type. It stays ClusterIP — internal
only. Grafana talks to it over the internal cluster network.

---

## Per-cloud values files

Check values-aws.yaml, values-gcp.yaml, and values-aks.yaml. If any of
them override Grafana service configuration, update them consistently.
Cloud-specific overrides should not conflict with the base values changes.

---

## Documentation updates

Update charts/omb/README.md to:

1. Add Grafana to the list of LoadBalancer services — make clear there
   are now TWO external addresses after helm install:
   - Control plane UI
   - Grafana

   Show how to get both:
   ```bash
   # Control plane UI
   kubectl get svc omb-control-plane -n omb \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

   # Grafana (AWS returns hostname, GCP/Azure return IP)
   kubectl get svc omb-kube-prometheus-stack-grafana -n omb \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
   ```
   Note: verify the exact Grafana service name by checking what
   kube-prometheus-stack names it — do not assume the name above is correct.

2. Add a warning that the default admin password must be changed before
   any customer engagement. Default credentials: admin / changeme.

3. Note that the Redpanda dashboard appears under Dashboards → Redpanda
   folder after deployment.

Update docs/deployment-aws.md, docs/deployment-gcp.md, and
docs/deployment-azure.md to include:
- The --set kube-prometheus-stack.grafana.adminPassword flag in the
  helm install command
- A step to retrieve the Grafana LoadBalancer address
- A note about the Redpanda dashboard location

---

## Validation

After helm upgrade:

```bash
# Both services have external addresses
kubectl get svc -n omb | grep LoadBalancer

# Grafana responds
curl http://<grafana-address>/api/health

# Login works with configured password
# Dashboards → Redpanda folder contains the Redpanda dashboard
# Prometheus datasource is configured and working (green check in
# Grafana → Connections → Data sources)
```

---

## Notes

- The exact service name for Grafana depends on the release name and
  subchart naming convention — check with kubectl get svc rather than
  assuming the name
- AWS LoadBalancers return a hostname, GCP and Azure return an IP —
  document both patterns in the README
- Do not change anything outside charts/omb/ in this session
