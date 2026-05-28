# ─── Build stage ─────────────────────────────────────────────────────────────
# Clones the Redpanda OMB fork and builds only the Kafka/Redpanda driver.
# The package module produces a tar.gz distribution; we extract it and strip
# all non-Kafka/Redpanda driver JARs to keep the final image small.
FROM maven:3.9-eclipse-temurin-21 AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 https://github.com/redpanda-data/openmessaging-benchmark /omb

WORKDIR /omb

# Build benchmark-framework + driver-kafka (+ transitive deps via -am).
# The package module assembles a tar.gz distribution.
RUN mvn clean package -DskipTests \
    -pl benchmark-framework,driver-kafka,package \
    -am \
    --no-transfer-progress

# Extract the distribution and remove all non-Kafka/Redpanda driver JARs.
# driver-api is the required interface; driver-kafka and driver-redpanda are
# the only protocol implementations we need.
RUN mkdir -p /opt/omb && \
    tar -xzf /omb/package/target/openmessaging-benchmark-0.0.1-SNAPSHOT-bin.tar.gz \
        -C /opt/omb \
        --strip-components=1 && \
    find /opt/omb/lib -name "io.openmessaging.benchmark-driver-*.jar" \
        ! -name "*-driver-api-*" \
        ! -name "*-driver-kafka-*" \
        ! -name "*-driver-redpanda-*" \
        -delete

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM eclipse-temurin:21-jre-jammy

WORKDIR /omb

COPY --from=builder /opt/omb/ /omb/
COPY entrypoint.sh /omb/entrypoint.sh

RUN chmod +x /omb/entrypoint.sh /omb/bin/benchmark-worker /omb/bin/benchmark

EXPOSE 9080

ENTRYPOINT ["/omb/entrypoint.sh"]
