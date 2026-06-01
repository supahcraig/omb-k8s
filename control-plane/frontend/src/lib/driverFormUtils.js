export const DRIVER_OPTIONS = [
  { label: 'Redpanda', value: 'redpanda', driverClass: 'io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver' },
  { label: 'Kafka',    value: 'kafka',    driverClass: 'io.openmessaging.benchmark.driver.kafka.KafkaBenchmarkDriver' },
]

const SECTION_KEYS = new Set(['topicConfig', 'producerConfig', 'consumerConfig', 'commonConfig'])

function parsePropLine(line) {
  const idx = line.indexOf('=')
  if (idx === -1) return { key: line.trim(), value: '' }
  return { key: line.slice(0, idx), value: line.slice(idx + 1) }
}

export function parseDriverYaml(yamlStr) {
  const result = { values: {}, topicConfig: [], producerConfig: [], consumerConfig: [], commonConfig: [] }
  if (!yamlStr) return result

  let currentSection = null

  for (const line of yamlStr.split('\n')) {
    const topMatch = line.match(/^([\w.]+):\s*(.*)$/)
    if (topMatch) {
      currentSection = null
      const [, key, rest] = topMatch
      const val = rest.trim()
      if (key === 'name') {
        const opt = DRIVER_OPTIONS.find(d => d.label === val)
        if (opt) result.values.driver = opt.value
      } else if (key === 'replicationFactor') {
        result.values.replicationFactor = Number(val)
      } else if (key === 'reset') {
        result.values.reset = val !== 'false'
      } else if (SECTION_KEYS.has(key) && val === '|') {
        currentSection = key
      }
      continue
    }
    const indented = line.match(/^  (.+)$/)
    if (indented && currentSection) {
      result[currentSection].push(parsePropLine(indented[1]))
    } else {
      currentSection = null
    }
  }

  return result
}

function buildSection(name, rows) {
  const filtered = rows.filter(r => r.key.trim())
  if (filtered.length === 0) return [`${name}: ""`]
  return [`${name}: |`, ...filtered.map(r => `  ${r.key}=${r.value}`)]
}

export function buildDriverYaml(values, { topicConfig, producerConfig, consumerConfig, commonConfig }) {
  const driverOpt = DRIVER_OPTIONS.find(d => d.value === values.driver) || DRIVER_OPTIONS[0]
  const out = [
    `name: ${driverOpt.label}`,
    `driverClass: ${driverOpt.driverClass}`,
    ``,
    `replicationFactor: ${values.replicationFactor}`,
    `reset: ${values.reset}`,
  ]
  out.push('', ...buildSection('commonConfig',   commonConfig))
  out.push('', ...buildSection('topicConfig',    topicConfig))
  out.push('', ...buildSection('producerConfig', producerConfig))
  out.push('', ...buildSection('consumerConfig', consumerConfig))
  return out.join('\n')
}

export function deriveProtocol(cluster) {
  if (!cluster) return ''
  if (cluster.tls_enabled && cluster.sasl_enabled) return 'SASL_SSL'
  if (cluster.tls_enabled) return 'SSL'
  if (cluster.sasl_enabled) return 'SASL_PLAINTEXT'
  return 'PLAINTEXT'
}

export function buildCommonConfigFromCluster(cluster) {
  if (!cluster?.bootstrap_servers) return []
  const rows = [{ key: 'bootstrap.servers', value: cluster.bootstrap_servers }]
  const protocol = deriveProtocol(cluster)
  if (protocol) rows.push({ key: 'security.protocol', value: protocol })
  if (cluster.sasl_enabled && cluster.sasl_mechanism) {
    rows.push({ key: 'sasl.mechanism', value: cluster.sasl_mechanism })
    const loginModule = cluster.sasl_mechanism === 'PLAIN'
      ? 'org.apache.kafka.common.security.plain.PlainLoginModule'
      : 'org.apache.kafka.common.security.scram.ScramLoginModule'
    if (cluster.sasl_username) {
      rows.push({
        key: 'sasl.jaas.config',
        value: `${loginModule} required username="${cluster.sasl_username}" password="${cluster.sasl_password || ''}";`,
      })
    }
  }
  return rows
}
