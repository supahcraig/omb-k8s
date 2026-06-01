import { describe, it, expect } from 'vitest'
import {
  parseDriverYaml,
  buildDriverYaml,
  buildCommonConfigFromCluster,
  deriveProtocol,
} from '../driverFormUtils.js'

const SAMPLE_YAML = `name: Redpanda
driverClass: io.openmessaging.benchmark.driver.redpanda.RedpandaBenchmarkDriver

replicationFactor: 3
reset: true

commonConfig: |
  bootstrap.servers=broker:9092
  security.protocol=SASL_SSL

topicConfig: |
  retention.ms=3600000

producerConfig: |
  acks=all
  linger.ms=1
  batch.size=131072

consumerConfig: |
  auto.offset.reset=earliest
  enable.auto.commit=false`

describe('parseDriverYaml', () => {
  it('parses driver name to driver value', () => {
    expect(parseDriverYaml(SAMPLE_YAML).values.driver).toBe('redpanda')
  })

  it('parses replicationFactor as number', () => {
    expect(parseDriverYaml(SAMPLE_YAML).values.replicationFactor).toBe(3)
  })

  it('parses reset as boolean', () => {
    expect(parseDriverYaml(SAMPLE_YAML).values.reset).toBe(true)
  })

  it('parses reset: false correctly', () => {
    expect(parseDriverYaml('replicationFactor: 1\nreset: false').values.reset).toBe(false)
  })

  it('parses topicConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).topicConfig).toEqual([
      { key: 'retention.ms', value: '3600000' },
    ])
  })

  it('parses producerConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).producerConfig).toEqual([
      { key: 'acks',       value: 'all'    },
      { key: 'linger.ms',  value: '1'      },
      { key: 'batch.size', value: '131072' },
    ])
  })

  it('parses consumerConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).consumerConfig).toEqual([
      { key: 'auto.offset.reset',  value: 'earliest' },
      { key: 'enable.auto.commit', value: 'false'    },
    ])
  })

  it('parses commonConfig block into key/value rows', () => {
    expect(parseDriverYaml(SAMPLE_YAML).commonConfig).toEqual([
      { key: 'bootstrap.servers', value: 'broker:9092' },
      { key: 'security.protocol', value: 'SASL_SSL'    },
    ])
  })

  it('returns empty arrays for missing sections', () => {
    const r = parseDriverYaml('name: Redpanda\ndriverClass: x\nreplicationFactor: 1\nreset: true')
    expect(r.topicConfig).toEqual([])
    expect(r.producerConfig).toEqual([])
    expect(r.consumerConfig).toEqual([])
    expect(r.commonConfig).toEqual([])
  })

  it('returns empty result for null input', () => {
    const r = parseDriverYaml(null)
    expect(r.values).toEqual({})
    expect(r.topicConfig).toEqual([])
  })
})

describe('buildDriverYaml', () => {
  const base = { driver: 'redpanda', replicationFactor: 3, reset: true }
  const full = {
    topicConfig:    [{ key: 'retention.ms', value: '3600000' }],
    producerConfig: [{ key: 'acks', value: 'all' }, { key: 'linger.ms', value: '1' }],
    consumerConfig: [{ key: 'auto.offset.reset', value: 'earliest' }],
    commonConfig:   [{ key: 'bootstrap.servers', value: 'broker:9092' }],
  }

  it('serializes non-empty section as block scalar', () => {
    const yaml = buildDriverYaml(base, full)
    expect(yaml).toContain('topicConfig: |')
    expect(yaml).toContain('  retention.ms=3600000')
    expect(yaml).toContain('producerConfig: |')
    expect(yaml).toContain('  acks=all')
  })

  it('serializes empty section as empty string sentinel', () => {
    const yaml = buildDriverYaml(base, { topicConfig: [], producerConfig: [], consumerConfig: [], commonConfig: [] })
    expect(yaml).toContain('topicConfig: ""')
    expect(yaml).toContain('producerConfig: ""')
    expect(yaml).toContain('consumerConfig: ""')
    expect(yaml).toContain('commonConfig: ""')
  })

  it('skips rows with empty keys', () => {
    const yaml = buildDriverYaml(base, {
      ...full,
      topicConfig: [{ key: '', value: 'ignored' }, { key: 'retention.ms', value: '3600000' }],
    })
    expect(yaml).not.toContain('  =ignored')
    expect(yaml).toContain('  retention.ms=3600000')
  })

  it('includes reset: false correctly', () => {
    const yaml = buildDriverYaml({ ...base, reset: false }, { topicConfig: [], producerConfig: [], consumerConfig: [], commonConfig: [] })
    expect(yaml).toContain('reset: false')
  })

  it('round-trips through parseDriverYaml', () => {
    const yaml = buildDriverYaml(base, full)
    const parsed = parseDriverYaml(yaml)
    expect(parsed.topicConfig).toEqual(full.topicConfig)
    expect(parsed.producerConfig).toEqual(full.producerConfig)
    expect(parsed.consumerConfig).toEqual(full.consumerConfig)
    expect(parsed.commonConfig).toEqual(full.commonConfig)
    expect(parsed.values.replicationFactor).toBe(3)
    expect(parsed.values.reset).toBe(true)
  })
})

describe('buildCommonConfigFromCluster', () => {
  it('returns empty array for null cluster', () => {
    expect(buildCommonConfigFromCluster(null)).toEqual([])
  })

  it('returns empty array when no bootstrap_servers', () => {
    expect(buildCommonConfigFromCluster({ bootstrap_servers: '' })).toEqual([])
  })

  it('returns bootstrap.servers and PLAINTEXT protocol', () => {
    const rows = buildCommonConfigFromCluster({ bootstrap_servers: 'b:9092', tls_enabled: false, sasl_enabled: false })
    expect(rows[0]).toEqual({ key: 'bootstrap.servers', value: 'b:9092' })
    expect(rows[1]).toEqual({ key: 'security.protocol', value: 'PLAINTEXT' })
  })

  it('includes SASL rows when sasl_enabled', () => {
    const rows = buildCommonConfigFromCluster({
      bootstrap_servers: 'b:9092',
      tls_enabled: true,
      sasl_enabled: true,
      sasl_mechanism: 'SCRAM-SHA-256',
      sasl_username: 'user1',
      sasl_password: 'pass1',
    })
    expect(rows.find(r => r.key === 'sasl.mechanism')?.value).toBe('SCRAM-SHA-256')
    expect(rows.find(r => r.key === 'sasl.jaas.config')?.value).toContain('username="user1"')
    expect(rows.find(r => r.key === 'sasl.jaas.config')?.value).toContain('password="pass1"')
  })

  it('handles PLAIN mechanism login module', () => {
    const rows = buildCommonConfigFromCluster({
      bootstrap_servers: 'b:9092',
      tls_enabled: false,
      sasl_enabled: true,
      sasl_mechanism: 'PLAIN',
      sasl_username: 'u',
      sasl_password: 'p',
    })
    expect(rows.find(r => r.key === 'sasl.jaas.config')?.value).toContain('PlainLoginModule')
  })
})

describe('deriveProtocol', () => {
  it('returns SASL_SSL for tls+sasl', () => {
    expect(deriveProtocol({ tls_enabled: true, sasl_enabled: true })).toBe('SASL_SSL')
  })
  it('returns SSL for tls only', () => {
    expect(deriveProtocol({ tls_enabled: true, sasl_enabled: false })).toBe('SSL')
  })
  it('returns SASL_PLAINTEXT for sasl only', () => {
    expect(deriveProtocol({ tls_enabled: false, sasl_enabled: true })).toBe('SASL_PLAINTEXT')
  })
  it('returns PLAINTEXT for neither', () => {
    expect(deriveProtocol({ tls_enabled: false, sasl_enabled: false })).toBe('PLAINTEXT')
  })
  it('returns empty string for null', () => {
    expect(deriveProtocol(null)).toBe('')
  })
})
