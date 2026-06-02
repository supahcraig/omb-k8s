// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_TOPOLOGY_ROWS = [
  { key: 'topics',                  value: '1'    },
  { key: 'partitionsPerTopic',      value: '100'  },
  { key: 'producersPerTopic',       value: '4'    },
  { key: 'consumerPerSubscription', value: '1'    },
  { key: 'subscriptionsPerTopic',   value: '1'    },
]

export const DEFAULT_LOAD_ROWS = [
  { key: 'messageSize',           value: '1024'   },
  { key: 'producerRate',          value: '100000' },
  { key: 'consumerBacklogSizeGB', value: '0'      },
]

export const DEFAULT_TIMING_ROWS = [
  { key: 'warmupDurationMinutes', value: '1'    },
  { key: 'testDurationMinutes',   value: '5'    },
  { key: 'sampleRateMillis',      value: '1000' },
]

export const DEFAULT_PAYLOAD_ROWS = [
  { key: 'useRandomizedPayloads',      value: 'false' },
  { key: 'randomizedPayloadPoolSize',  value: '1000'  },
]

// ── Smart input metadata ─────────────────────────────────────────────────────

export const WORKLOAD_KNOWN_PROP_OPTIONS = {
  'useRandomizedPayloads': { type: 'toggle' },
}

export const WORKLOAD_KNOWN_PROP_TYPES = {
  'topics':                    'number',
  'partitionsPerTopic':        'number',
  'messageSize':               'number',
  'subscriptionsPerTopic':     'number',
  'producersPerTopic':         'number',
  'consumerPerSubscription':   'number',
  'producerRate':              'number',
  'consumerBacklogSizeGB':     'number',
  'testDurationMinutes':       'number',
  'warmupDurationMinutes':     'number',
  'sampleRateMillis':          'number',
  'randomizedPayloadPoolSize': 'number',
}

export const WORKLOAD_PROP_HINTS = {
  'messageSize':            'bytes',
  'producerRate':           'msg/s',
  'consumerBacklogSizeGB':  'GB',
  'warmupDurationMinutes':  'min',
  'testDurationMinutes':    'min',
  'sampleRateMillis':           'ms',
  'randomizedPayloadPoolSize':  'distinct payloads',
}

// ── Section membership ───────────────────────────────────────────────────────

const TOPOLOGY_KEYS = new Set(['topics','partitionsPerTopic','producersPerTopic','consumerPerSubscription','subscriptionsPerTopic'])
const LOAD_KEYS     = new Set(['messageSize','producerRate','consumerBacklogSizeGB'])
const TIMING_KEYS   = new Set(['warmupDurationMinutes','testDurationMinutes','sampleRateMillis'])
const PAYLOAD_KEYS  = new Set(['useRandomizedPayloads','randomizedPayloadPoolSize'])

// ── Row parser ───────────────────────────────────────────────────────────────

export function parseWorkloadYamlToRows(yamlStr) {
  const empty = { topology: [], load: [], timing: [], payload: [], extra: [] }
  if (!yamlStr) return empty

  const topology = [], load = [], timing = [], payload = [], extra = []

  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (!match) continue
    const [, key, rawVal] = match
    if (key === 'payloadFile') continue
    const row = { key, value: rawVal.trim() }
    if      (TOPOLOGY_KEYS.has(key))  topology.push(row)
    else if (LOAD_KEYS.has(key))      load.push(row)
    else if (TIMING_KEYS.has(key))    timing.push(row)
    else if (PAYLOAD_KEYS.has(key))   payload.push(row)
    else                              extra.push(row)
  }

  return { topology, load, timing, payload, extra }
}

// ── YAML builder ─────────────────────────────────────────────────────────────

export function buildWorkloadYaml(allRows) {
  const lines = allRows
    .filter(r => r.key.trim() && r.key !== 'payloadFile' && String(r.value).trim() !== '')
    .map(r => `${r.key}: ${r.value}`)
  lines.push('payloadFile: /payload/payload.data')
  return lines.join('\n')
}

// ── Backward-compatible parser (used by RunDetailPage) ────────────────────────

const VALUE_DEFAULTS = {
  topics: 1, partitionsPerTopic: 100, messageSize: 1024, subscriptionsPerTopic: 1,
  producersPerTopic: 4, consumerPerSubscription: 1, producerRate: 100000,
  consumerBacklogSizeGB: 0, testDurationMinutes: 5, warmupDurationMinutes: 1,
  sampleRateMillis: 1000, useRandomizedPayloads: false, randomizedPayloadPoolSize: '',
}

export function parseWorkloadYaml(yamlStr) {
  const values = { ...VALUE_DEFAULTS }
  const customFields = []
  if (!yamlStr) return { values, customFields }

  for (const line of yamlStr.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (!match) continue
    const [, key, rawVal] = match
    const val = rawVal.trim()
    if (key === 'payloadFile') continue
    let parsed
    if (val === 'true')       parsed = true
    else if (val === 'false') parsed = false
    else { const num = Number(val); parsed = !isNaN(num) && val !== '' ? num : val }
    if (key in VALUE_DEFAULTS) values[key] = parsed
    else customFields.push({ key, value: val })
  }
  return { values, customFields }
}
