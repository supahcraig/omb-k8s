import { describe, it, expect } from 'vitest'
import {
  parseWorkloadYamlToRows,
  buildWorkloadYaml,
  parseWorkloadYaml,
  WORKLOAD_KNOWN_PROP_OPTIONS,
  WORKLOAD_KNOWN_PROP_TYPES,
  WORKLOAD_PROP_HINTS,
  DEFAULT_TOPOLOGY_ROWS,
  DEFAULT_LOAD_ROWS,
  DEFAULT_TIMING_ROWS,
  DEFAULT_PAYLOAD_ROWS,
} from '../workloadFormUtils.js'

const SAMPLE_YAML = `topics: 2
partitionsPerTopic: 50
producersPerTopic: 2
consumerPerSubscription: 1
subscriptionsPerTopic: 1
messageSize: 512
producerRate: 50000
consumerBacklogSizeGB: 0
warmupDurationMinutes: 2
testDurationMinutes: 10
sampleRateMillis: 1000
useRandomizedPayloads: false
payloadFile: /payload/payload.data`

describe('parseWorkloadYamlToRows', () => {
  it('parses topology keys into topology section', () => {
    const { topology } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(topology.find(r => r.key === 'topics')?.value).toBe('2')
    expect(topology.find(r => r.key === 'partitionsPerTopic')?.value).toBe('50')
  })

  it('parses load keys into load section', () => {
    const { load } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(load.find(r => r.key === 'messageSize')?.value).toBe('512')
    expect(load.find(r => r.key === 'producerRate')?.value).toBe('50000')
  })

  it('parses timing keys into timing section', () => {
    const { timing } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(timing.find(r => r.key === 'warmupDurationMinutes')?.value).toBe('2')
    expect(timing.find(r => r.key === 'testDurationMinutes')?.value).toBe('10')
  })

  it('parses payload keys into payload section', () => {
    const { payload } = parseWorkloadYamlToRows(SAMPLE_YAML)
    expect(payload.find(r => r.key === 'useRandomizedPayloads')?.value).toBe('false')
  })

  it('skips payloadFile', () => {
    const { topology, load, timing, payload, extra } = parseWorkloadYamlToRows(SAMPLE_YAML)
    const all = [...topology, ...load, ...timing, ...payload, ...extra]
    expect(all.find(r => r.key === 'payloadFile')).toBeUndefined()
  })

  it('puts unknown keys into extra', () => {
    const yaml = `topics: 1\ncustomKey: customValue`
    const { extra } = parseWorkloadYamlToRows(yaml)
    expect(extra).toEqual([{ key: 'customKey', value: 'customValue' }])
  })

  it('returns all empty arrays for null input', () => {
    const result = parseWorkloadYamlToRows(null)
    expect(result.topology).toEqual([])
    expect(result.load).toEqual([])
    expect(result.extra).toEqual([])
  })
})

describe('buildWorkloadYaml', () => {
  it('emits flat key: value lines', () => {
    const yaml = buildWorkloadYaml([
      { key: 'topics', value: '1' },
      { key: 'messageSize', value: '1024' },
    ])
    expect(yaml).toContain('topics: 1')
    expect(yaml).toContain('messageSize: 1024')
  })

  it('always appends payloadFile', () => {
    const yaml = buildWorkloadYaml([{ key: 'topics', value: '1' }])
    expect(yaml).toContain('payloadFile: /payload/payload.data')
  })

  it('skips rows with empty keys', () => {
    const yaml = buildWorkloadYaml([{ key: '', value: 'ignored' }, { key: 'topics', value: '1' }])
    expect(yaml).not.toContain(': ignored')
    expect(yaml).toContain('topics: 1')
  })

  it('skips rows with empty values', () => {
    const yaml = buildWorkloadYaml([
      { key: 'topics', value: '' },
      { key: 'messageSize', value: '1024' },
    ])
    expect(yaml).not.toContain('topics:')
    expect(yaml).toContain('messageSize: 1024')
  })

  it('does not duplicate payloadFile if already present', () => {
    const yaml = buildWorkloadYaml([
      { key: 'topics', value: '1' },
      { key: 'payloadFile', value: '/payload/payload.data' },
    ])
    const count = (yaml.match(/payloadFile/g) || []).length
    expect(count).toBe(1)
  })
})

describe('parseWorkloadYaml (backward compat)', () => {
  it('returns numeric values for number fields', () => {
    const { values } = parseWorkloadYaml(SAMPLE_YAML)
    expect(values.topics).toBe(2)
    expect(values.messageSize).toBe(512)
    expect(values.producerRate).toBe(50000)
  })

  it('returns boolean for useRandomizedPayloads', () => {
    const { values } = parseWorkloadYaml(SAMPLE_YAML)
    expect(values.useRandomizedPayloads).toBe(false)
  })

  it('puts unknown keys in customFields', () => {
    const yaml = `topics: 1\ncustomKey: hello`
    const { customFields } = parseWorkloadYaml(yaml)
    expect(customFields).toContainEqual({ key: 'customKey', value: 'hello' })
  })

  it('returns DEFAULTS for missing keys', () => {
    const { values } = parseWorkloadYaml('')
    expect(values.topics).toBe(1)
    expect(values.partitionsPerTopic).toBe(100)
  })
})

describe('defaults', () => {
  it('DEFAULT_TOPOLOGY_ROWS has all 5 topology keys', () => {
    const keys = DEFAULT_TOPOLOGY_ROWS.map(r => r.key)
    expect(keys).toContain('topics')
    expect(keys).toContain('partitionsPerTopic')
    expect(keys).toContain('producersPerTopic')
    expect(keys).toContain('consumerPerSubscription')
    expect(keys).toContain('subscriptionsPerTopic')
  })

  it('DEFAULT_LOAD_ROWS has messageSize, producerRate, consumerBacklogSizeGB', () => {
    const keys = DEFAULT_LOAD_ROWS.map(r => r.key)
    expect(keys).toContain('messageSize')
    expect(keys).toContain('producerRate')
    expect(keys).toContain('consumerBacklogSizeGB')
  })

  it('DEFAULT_TIMING_ROWS has warmup, test, sampleRate', () => {
    const keys = DEFAULT_TIMING_ROWS.map(r => r.key)
    expect(keys).toContain('warmupDurationMinutes')
    expect(keys).toContain('testDurationMinutes')
    expect(keys).toContain('sampleRateMillis')
  })

  it('DEFAULT_PAYLOAD_ROWS has useRandomizedPayloads=false', () => {
    expect(DEFAULT_PAYLOAD_ROWS[0].key).toBe('useRandomizedPayloads')
    expect(DEFAULT_PAYLOAD_ROWS[0].value).toBe('false')
  })
})

describe('WORKLOAD_KNOWN_PROP_OPTIONS', () => {
  it('defines useRandomizedPayloads as toggle', () => {
    expect(WORKLOAD_KNOWN_PROP_OPTIONS['useRandomizedPayloads'].type).toBe('toggle')
  })
})

describe('WORKLOAD_KNOWN_PROP_TYPES', () => {
  it('marks numeric workload fields as number', () => {
    expect(WORKLOAD_KNOWN_PROP_TYPES['topics']).toBe('number')
    expect(WORKLOAD_KNOWN_PROP_TYPES['messageSize']).toBe('number')
    expect(WORKLOAD_KNOWN_PROP_TYPES['producerRate']).toBe('number')
  })
})

describe('WORKLOAD_PROP_HINTS', () => {
  it('has hints for key fields', () => {
    expect(WORKLOAD_PROP_HINTS['messageSize']).toBe('bytes')
    expect(WORKLOAD_PROP_HINTS['producerRate']).toBe('msg/s')
    expect(WORKLOAD_PROP_HINTS['warmupDurationMinutes']).toBe('min')
    expect(WORKLOAD_PROP_HINTS['testDurationMinutes']).toBe('min')
    expect(WORKLOAD_PROP_HINTS['sampleRateMillis']).toBe('ms')
  })
})
