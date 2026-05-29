import { useEffect, useState } from 'react'
import { getSettings, updateSettings, testConnection } from '../api.js'
import { useSettings } from '../context/SettingsContext.jsx'

function ChipInput({ values, onChange, placeholder }) {
  const [inputVal, setInputVal] = useState('')

  function commit(raw) {
    const v = raw.trim()
    if (!v) return
    onChange([...values, v])
    setInputVal('')
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(inputVal) }
    else if (e.key === 'Backspace' && inputVal === '') onChange(values.slice(0, -1))
  }

  return (
    <div className="chip-input" onClick={e => e.currentTarget.querySelector('input')?.focus()}>
      {values.map((v, i) => (
        <span key={i} className="chip-value">
          {v}
          <button type="button" className="chip-remove"
            onClick={() => onChange(values.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
      <input
        className="chip-input-field"
        value={inputVal}
        onChange={e => setInputVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(inputVal)}
        placeholder={values.length === 0 ? (placeholder || 'hostname:9092, press Enter') : ''}
      />
    </div>
  )
}

function PasswordField({ label, hint, hasSaved, value, onChange }) {
  const [changing, setChanging] = useState(!hasSaved)

  useEffect(() => {
    if (hasSaved) setChanging(false)
  }, [hasSaved])

  if (!changing) {
    return (
      <div className="form-group">
        <label className="form-label">{label}</label>
        <div className="password-display">
          <span className="password-dots">••••••••</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => {
            onChange('')
            setChanging(true)
          }}>
            Change
          </button>
        </div>
        {hint && <span className="form-hint">{hint}</span>}
      </div>
    )
  }

  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input
        type="password"
        className="form-input"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
      {hint && <span className="form-hint">{hint}</span>}
    </div>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <div className="toggle-row">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className="toggle-slider" />
      </label>
      <span className="toggle-label">{label}</span>
    </div>
  )
}

// ── Cluster Connectivity Tab ─────────────────────────────────────────────────

function ClusterTab({ initial, onChange }) {
  const initBrokers = (initial?.bootstrap_servers || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  const [brokers, setBrokers] = useState(initBrokers)
  const [tlsEnabled, setTlsEnabled] = useState(initial?.tls_enabled ?? false)
  const [saslEnabled, setSaslEnabled] = useState(initial?.sasl_enabled ?? false)
  const [saslMechanism, setSaslMechanism] = useState(initial?.sasl_mechanism || 'SCRAM-SHA-256')
  const [username, setUsername] = useState(initial?.sasl_username || '')
  const [password, setPassword] = useState('')
  const [passwordChanged, setPasswordChanged] = useState(false)

  const hasSavedPassword = !!initial && !passwordChanged

  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  function buildConfig() {
    return {
      mode: 'self-hosted',
      bootstrap_servers: brokers.join(','),
      tls_enabled: tlsEnabled,
      sasl_enabled: saslEnabled,
      sasl_mechanism: saslEnabled ? saslMechanism : null,
      sasl_username: saslEnabled ? username : null,
      sasl_password: saslEnabled && passwordChanged ? password : null,
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveMsg(null)
    try {
      await onChange(buildConfig())
      setSaveMsg({ type: 'success', text: 'Settings saved.' })
      setPasswordChanged(false)
    } catch (e) {
      setSaveMsg({ type: 'error', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    if (!initial) {
      setTestResult({ success: false, message: 'Save settings before testing connection.' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection()
      setTestResult(result)
    } catch (e) {
      setTestResult({ success: false, message: e.message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <div className="form-group">
        <label className="form-label">Seed Brokers</label>
        <ChipInput
          values={brokers}
          onChange={setBrokers}
          placeholder="hostname:9092 — press Enter or comma to add"
        />
        <span className="form-hint">Add each broker address individually.</span>
      </div>

      <Toggle checked={tlsEnabled} onChange={setTlsEnabled} label="TLS" />
      <div className="mt-12">
        <Toggle checked={saslEnabled} onChange={setSaslEnabled} label="SASL" />
      </div>

      {saslEnabled && (
        <div className="mt-16">
          <div className="form-group">
            <label className="form-label">SASL Mechanism</label>
            <select className="form-select" value={saslMechanism} onChange={e => setSaslMechanism(e.target.value)}>
              <option value="SCRAM-SHA-256">SCRAM-SHA-256</option>
              <option value="SCRAM-SHA-512">SCRAM-SHA-512</option>
              <option value="PLAIN">PLAIN</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Username</label>
            <input className="form-input" value={username} onChange={e => setUsername(e.target.value)} />
          </div>
          <PasswordField
            label="Password"
            hasSaved={hasSavedPassword}
            value={password}
            onChange={v => { setPassword(v); setPasswordChanged(true) }}
          />
        </div>
      )}

      {saveMsg && (
        <div className={`alert alert-${saveMsg.type === 'success' ? 'success' : 'error'}`}>
          {saveMsg.text}
        </div>
      )}

      <div className="flex gap-8 mt-20">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><span className="spinner" /> Saving…</> : 'Save'}
        </button>
        <button className="btn btn-secondary" onClick={handleTest} disabled={testing}>
          {testing ? <><span className="spinner spinner-dark" /> Testing…</> : 'Test Connection'}
        </button>
      </div>

      {testResult && (
        <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
          <span>{testResult.success ? '✓' : '✗'}</span>
          <span>{testResult.message}</span>
        </div>
      )}
    </div>
  )
}

// ── Prometheus Tab ────────────────────────────────────────────────────────────

function PrometheusTab({ initial, onChange }) {
  const [scrapeTargets, setScrapeTargets] = useState(
    Array.isArray(initial?.scrape_targets)
      ? initial.scrape_targets.join(',')
      : (initial?.scrape_targets || '')
  )
  const [scrapeYaml, setScrapeYaml] = useState(initial?.scrape_yaml || '')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)

  function buildConfig() {
    if (scrapeYaml.trim()) {
      return { mode: 'byoc', scrape_yaml: scrapeYaml.trim(), scrape_targets: null }
    }
    return {
      mode: 'self-hosted',
      scrape_yaml: null,
      scrape_targets: scrapeTargets
        ? scrapeTargets.split(',').map(s => s.trim()).filter(Boolean)
        : null,
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveMsg(null)
    try {
      await onChange(buildConfig())
      setSaveMsg({ type: 'success', text: 'Prometheus configuration saved.' })
    } catch (e) {
      setSaveMsg({ type: 'error', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        Broker scrape targets are probed at run start and logged for diagnostics. Chart integration for broker-side metrics is in progress.
      </div>
      <div className="form-group">
        <label className="form-label">Scrape Targets <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(self-hosted)</span></label>
        <input
          className="form-input"
          value={scrapeTargets}
          onChange={e => { setScrapeTargets(e.target.value); if (e.target.value) setScrapeYaml('') }}
          placeholder="broker-1:9644,broker-2:9644,broker-3:9644"
        />
        <span className="form-hint">Redpanda metrics port (default 9644), comma-separated.</span>
      </div>
      <div className="form-group">
        <label className="form-label">Scrape Config YAML <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(BYOC — overrides targets above)</span></label>
        <textarea
          className="form-input"
          rows={8}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          value={scrapeYaml}
          onChange={e => { setScrapeYaml(e.target.value); if (e.target.value) setScrapeTargets('') }}
          placeholder={'job_name: redpanda\nstatic_configs:\n  - targets: [\'broker:9644\']\nbasic_auth:\n  username: prometheus\n  password: secret'}
        />
        <span className="form-hint">Full Prometheus scrape job YAML with auth. Targets are extracted and probed at run start.</span>
      </div>

      {saveMsg && (
        <div className={`alert alert-${saveMsg.type === 'success' ? 'success' : 'error'} mt-16`}>
          {saveMsg.text}
        </div>
      )}

      <div className="mt-20">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><span className="spinner" /> Saving…</> : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Main Settings Page ────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { reload: reloadSettings } = useSettings()
  const [activeTab, setActiveTab] = useState('cluster')
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    getSettings()
      .then(s => { setSettings(s); setLoading(false) })
      .catch(e => { setLoadError(e.message); setLoading(false) })
  }, [])

  async function saveCluster(clusterConfig) {
    const updated = await updateSettings({
      cluster: clusterConfig,
      prometheus: settings?.prometheus ?? null,
    })
    setSettings(updated)
    reloadSettings()
  }

  async function savePrometheus(prometheusConfig) {
    const updated = await updateSettings({
      cluster: settings?.cluster ?? null,
      prometheus: prometheusConfig,
    })
    setSettings(updated)
    reloadSettings()
  }

  if (loading) return <div className="text-muted mt-20">Loading settings…</div>
  if (loadError) return <div className="alert alert-error">Failed to load settings: {loadError}</div>

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-body">
          <div className="tabs">
            <button
              className={`tab${activeTab === 'cluster' ? ' active' : ''}`}
              onClick={() => setActiveTab('cluster')}
            >
              Cluster Connectivity
            </button>
            <button
              className={`tab${activeTab === 'prometheus' ? ' active' : ''}`}
              onClick={() => setActiveTab('prometheus')}
            >
              Prometheus
            </button>
          </div>

          {activeTab === 'cluster' && (
            <ClusterTab
              initial={settings?.cluster}
              onChange={saveCluster}
            />
          )}

          {activeTab === 'prometheus' && (
            <PrometheusTab
              initial={settings?.prometheus}
              onChange={savePrometheus}
            />
          )}
        </div>
      </div>
    </div>
  )
}
