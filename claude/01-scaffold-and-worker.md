Read CLAUDE.md fully before doing anything else.

This is session 1 of 6. Your deliverables for this session are:

1. Create the repo directory structure exactly as specified in CLAUDE.md
2. A working README.md skeleton with sections: Overview, Prerequisites, 
   Quick Start, Deployment, Scaling Workers, Tearing Down
3. A .gitignore appropriate for a repo containing Terraform, Helm, Python, 
   React, and Docker
4. Add terraform/engagements/ to .gitignore with a comment explaining why
5. The worker Dockerfile and entrypoint script
6. The GitHub Actions workflow for building and pushing the worker image

## Worker Dockerfile requirements

Base image: eclipse-temurin:21-jre-jammy

Build steps:
- Clone https://github.com/redpanda-data/openmessaging-benchmark
- Build with Maven, including ONLY the Kafka/Redpanda driver. Strip all other 
  drivers (Pulsar, RabbitMQ, Pravega, etc.) from the build to keep the image small
- Copy the built JAR and bin/benchmark script into the image
- Copy the Redpanda driver YAML files into the image

Entrypoint script requirements:
- Start the OMB worker process (not the driver — the worker)
- Set JVM heap: -Xms4G -Xmx4G. These are fixed values, not env vars.
- Additional recommended JVM flags for a containerized benchmark workload: 
  -XX:+UseG1GC -XX:MaxGCPauseMillis=10 -XX:+ParallelRefProcEnabled
- Worker listens on port 8080
- Script must handle SIGTERM gracefully for clean pod shutdown

Expose port 8080.

The same image is used for both worker pods (long-running) and driver Jobs 
(short-lived). The entrypoint script should detect via an environment variable 
(OMB_MODE=worker|driver) whether to start the worker process or pass through 
arguments to bin/benchmark for driver mode.

## GitHub Actions workflow requirements

File: .github/workflows/build-worker.yml

Triggers:
- Push to main when files under worker/ change
- Manual dispatch with a version input (string, optional)

Steps:
- Checkout
- Set up Docker Buildx
- Login to ghcr.io using GITHUB_TOKEN (no additional secrets needed)
- Build and push image
- Tags: ghcr.io/${{ github.repository_owner }}/omb-worker:${{ github.sha }}
  and ghcr.io/${{ github.repository_owner }}/omb-worker:latest
- If manual dispatch with version input provided, also tag with that version

## Validation

The worker image must be locally runnable and testable:
docker build -t omb-worker worker/
docker run --rm -p 8080:8080 omb-worker
curl http://localhost:8080/api/v1/workers/status  (or equivalent health endpoint)

Document the validation steps in worker/README.md.

Do not start on Terraform, Helm, or the control plane. That is session 2 and 3.
