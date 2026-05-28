# OMB Worker Image

The OMB worker runs the OpenMessaging Benchmark worker process. It listens on
port 9080 and accepts benchmark commands from the control plane.

Worker pods run as a StatefulSet so each pod gets a stable DNS name
(`omb-worker-0.omb-worker:9080`, etc.). Do not convert to a Deployment.

## Building locally

```bash
docker build -t omb-worker worker/
```

The build clones the Redpanda OMB fork and compiles only the Kafka/Redpanda
driver. Expect the first build to take 5–10 minutes (Maven dependency download
+ compilation). Subsequent builds are fast due to Docker layer caching.

## Running locally

Start the worker:

```bash
docker run --rm -p 9080:9080 -e OMB_MODE=worker omb-worker
```

Verify it is healthy:

```bash
curl http://localhost:9080/counters-stats
```

Expected response: `200 OK` with JSON showing zero message counts (worker is idle):
```json
{"messagesSent": 0, "messagesReceived": 0}
```

You can also hit `/period-stats` for a richer histogram response.

To run the driver/coordinator mode (used by the control plane when launching
benchmark Jobs):

```bash
docker run --rm -e OMB_MODE=driver omb-worker \
  --drivers /etc/omb/driver.yaml \
  /etc/omb/workload.yaml \
  --workers http://omb-worker-0.omb-worker:9080
```

## Environment variables

| Variable   | Values            | Default  | Description                         |
|------------|-------------------|----------|-------------------------------------|
| `OMB_MODE` | `worker`/`driver` | `worker` | Start as worker listener or driver  |

## Image contents

- Base: `eclipse-temurin:21-jre-jammy`
- OMB framework JARs (`lib/`)
- Kafka/Redpanda driver JAR (`lib/`)
- Benchmark scripts (`bin/benchmark`, `bin/benchmark-worker`)
- Redpanda driver YAML configs (`driver-kafka/`)

## JVM settings

JVM flags are fixed in `entrypoint.sh` and are not configurable. Worker pods
are standardized at 4 vCPU / 8 GB. To increase throughput, add more worker
pods — do not change instance types or heap settings.

## Published image

```
ghcr.io/<org>/omb-worker:latest
ghcr.io/<org>/omb-worker:<git-sha>
```

The GitHub Actions workflow at `.github/workflows/build-worker.yml` builds and
pushes automatically on pushes to `main` that modify files under `worker/`.
