import { useEffect, useState } from 'react'
import { listDrivers, listWorkloads } from '../api.js'

const C = {
  bg:     '#161b2e',
  header: '#1e2538',
  border: '#2a3045',
  text:   '#e8edf8',
  muted:  '#7a8399',
  tag:    'rgba(99,102,241,0.15)',
  tagText:'#818cf8',
}

function parseDriverTags(content) {
  const tags = []
  let driver = null
  for (const raw of content.split('\n')) {
    const t = raw.trim()
    if (t.startsWith('name:') && !driver) {
      driver = t.split(':')[1]?.trim()
      if (driver) tags.push(driver)
    } else if (t.startsWith('acks=')) {
      tags.push(`acks=${t.split('=')[1]}`)
    } else if (t.startsWith('compression.type=')) {
      const v = t.split('=')[1]; if (v && v !== 'none') tags.push(v)
    } else if (t.startsWith('batch.size=')) {
      const n = parseInt(t.split('=')[1])
      if (!isNaN(n)) tags.push(n >= 1024 ? `${n / 1024}KB batch` : `${n}B batch`)
    } else if (t.startsWith('min.insync.replicas=')) {
      tags.push(`min.isr=${t.split('=')[1]}`)
    }
  }
  return tags
}

function parseWorkloadTags(content) {
  const tags = []
  for (const line of content.split('\n')) {
    const msg = line.match(/^\s*messageSize\s*:\s*(\d+)/)
    if (msg) { const n = parseInt(msg[1]); tags.push(n >= 1024 ? `${n / 1024}KB` : `${n}B`) }
    const part = line.match(/^\s*partitionsPerTopic\s*:\s*(\d+)/)
    if (part) tags.push(`${part[1]} partitions`)
    const rate = line.match(/^\s*producerRate\s*:\s*(\d+)/)
    if (rate) {
      const r = parseInt(rate[1])
      tags.push(r >= 1000000 ? `${(r/1000000).toFixed(1)}M msg/s` : r >= 1000 ? `${(r/1000).toFixed(0)}K msg/s` : `${r} msg/s`)
    }
  }
  return tags
}

function EntryCard({ entry, type, onApply }) {
  const [expanded, setExpanded] = useState(false)
  const tags = type === 'driver' ? parseDriverTags(entry.content) : parseWorkloadTags(entry.content)

  return (
    <div style={{
      border: `1px solid ${expanded ? '#3b82f6' : C.border}`,
      borderRadius: 6,
      marginBottom: 8,
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      {/* Card header row */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 12px', cursor: 'pointer',
          background: expanded ? 'rgba(59,130,246,0.08)' : C.header,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{entry.name}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {tags.map((t, i) => (
              <span key={i} style={{
                fontSize: 11, padding: '1px 7px', borderRadius: 10,
                background: C.tag, color: C.tagText, fontWeight: 500,
              }}>{t}</span>
            ))}
          </div>
        </div>
        <span style={{ color: C.muted, fontSize: 16, marginLeft: 8, flexShrink: 0 }}>
          {expanded ? '▼' : '▶'}
        </span>
      </div>

      {/* Expanded YAML preview */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          <pre style={{
            margin: 0, padding: '10px 12px',
            fontSize: 11, lineHeight: 1.5,
            color: '#a5b4fc',
            background: '#0d1018',
            overflowX: 'auto',
            maxHeight: 280,
            overflowY: 'auto',
            fontFamily: 'monospace',
          }}>{entry.content}</pre>
          <div style={{ padding: '8px 12px', background: C.header, borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={e => { e.stopPropagation(); onApply(entry.content, entry.name) }}
            >
              Use this config
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function LibraryDrawer({ type, open, onClose, onApply }) {
  const [items, setItems] = useState({ bundled: [], custom: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    const loader = type === 'driver' ? listDrivers : listWorkloads
    loader()
      .then(data => { setItems(data); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [open, type])

  const title = type === 'driver' ? 'Driver Library' : 'Workload Library'

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 999,
          }}
        />
      )}

      {/* Drawer panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 440,
        background: C.bg,
        borderLeft: `1px solid ${C.border}`,
        zIndex: 1000,
        display: 'flex', flexDirection: 'column',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.22s ease',
        boxShadow: open ? '-8px 0 32px rgba(0,0,0,0.4)' : 'none',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 16px',
          background: C.header,
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: C.muted, fontSize: 20, lineHeight: 1, padding: '0 4px',
            }}
            aria-label="Close"
          >×</button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px' }}>
          {loading && <div style={{ color: C.muted, fontSize: 13, padding: 8 }}>Loading…</div>}
          {error && <div style={{ color: '#ef4444', fontSize: 13, padding: 8 }}>{error}</div>}

          {!loading && !error && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2 }}>
                Bundled
              </div>
              {items.bundled.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 13, padding: '8px 4px' }}>No bundled {type}s found.</div>
              ) : items.bundled.map(entry => (
                <EntryCard key={entry.id} entry={entry} type={type} onApply={onApply} />
              ))}

              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '16px 0 8px', paddingLeft: 2 }}>
                Custom
              </div>
              {items.custom.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 13, padding: '8px 4px' }}>
                  No custom {type}s saved yet.{' '}
                  <a href="/workloads" style={{ color: '#818cf8' }}>Open Library</a> to create one.
                </div>
              ) : items.custom.map(entry => (
                <EntryCard key={entry.id} entry={entry} type={type} onApply={onApply} />
              ))}
            </>
          )}
        </div>
      </div>
    </>
  )
}
