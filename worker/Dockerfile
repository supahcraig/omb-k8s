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

# Patch both Kafka and Redpanda drivers to make topicNamePrefix configurable
# from the driver YAML. Without this, all runs share the hardcoded prefix
# "test-topic" and each new run's worker init deletes every topic matching
# that prefix — including topics owned by concurrently running benchmarks.
RUN KAFKA_CONFIG="driver-kafka/src/main/java/io/openmessaging/benchmark/driver/kafka/Config.java" && \
    KAFKA_DRIVER="driver-kafka/src/main/java/io/openmessaging/benchmark/driver/kafka/KafkaBenchmarkDriver.java" && \
    RP_CONFIG="driver-redpanda/src/main/java/io/openmessaging/benchmark/driver/redpanda/Config.java" && \
    RP_DRIVER="driver-redpanda/src/main/java/io/openmessaging/benchmark/driver/redpanda/RedpandaBenchmarkDriverBase.java" && \
    sed -i 's/public short replicationFactor;/public String topicNamePrefix = "test-topic";\n\n    public short replicationFactor;/' "$KAFKA_CONFIG" "$RP_CONFIG" && \
    sed -i 's/return "test-topic";/return config.topicNamePrefix;/' "$KAFKA_DRIVER" "$RP_DRIVER" && \
    echo "OMB topic prefix patch applied"

# Build benchmark-framework + both drivers + package (+ transitive deps via -am).
# The package module assembles a tar.gz distribution.
RUN mvn clean package -DskipTests \
    -pl benchmark-framework,driver-kafka,driver-redpanda,package \
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
