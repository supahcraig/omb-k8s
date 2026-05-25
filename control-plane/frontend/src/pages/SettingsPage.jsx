import { useEffect, useState } from 'react'
import { getSettings, updateSettings, testConnection } from '../api.js'
import { useSettings } from '../context/SettingsContext.jsx'

// A password field that masks saved values and requires an explicit "Change" click
function PasswordField({ label, hint, hasSaved, value, onChange }) {
  const [changing, setChanging] = useState(!hasSaved)

  // If hasSaved transitions from false→true (after first save), keep input shown
  // but if we load settings and see a saved value, start masked
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
  const [mode, setMode] = useState(initial?.mode || 'byoc')
  const [bootstrap, setBootstrap] = useState(initial?.bootstrap_servers || '')
  const [tlsEnabled, setTlsEnabled] = useState(initial?.tls_enabled ?? false)
  const [saslEnabled, setSaslEnabled] = useState(initial?.sasl_enabled ?? false)
  const [saslMechanism, setSaslMechanism] = useState(initial?.sasl_mechanism || 'SCRAM-SHA-256')
  const [username, setUsername] = useState(initial?.sasl_username || '')
  const [password, setPassword] = useState('')
  const [passwordChanged, setPasswordChanged] = useState(false)

  // hasSaved = settings exist and we haven't just entered a new password
  const hasSavedPassword = !!initial && !passwordChanged

  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  function buildConfig() {
    if (mode === 'byoc') {
      return {
        mode: 'byoc',
        bootstrap_servers: bootstrap,
        tls_enabled: true,
        sasl_enabled: true,
        sasl_mechanism: 'SCRAM-SHA-256',
        sasl_username: username,
        sasl_password: passwordChanged ? password : null,
      }
    }
    return {
      mode: 'self-hosted',
      bootstrap_servers: bootstrap,
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
    // Must save first so the backend can use stored credentials
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
      <div className="mode-tabs">
        <button className={`mode-tab${mode === 'byoc' ? ' active' : ''}`} onClick={() => setMode('byoc')}>
          BYOC (Redpanda Cloud)
        </button>
        <button className={`mode-tab${mode === 'self-hosted' ? ' active' : ''}`} onClick={() => setMode('self-hosted')}>
          Self-Hosted
        </button>
      </div>

      <div className="form-group">
        <label className="form-label">
          {mode === 'byoc' ? 'Bootstrap Server' : 'Seed Brokers'}
        </label>
        <input
          className="form-input"
          value={bootstrap}
          onChange={e => setBootstrap(e.target.value)}
          placeholder={mode === 'byoc'
            ? 'hostname.region.byoc.prd.cloud.redpanda.com:9092'
            : 'broker-1:9092,broker-2:9092,broker-3:9092'
          }
        />
        {mode === 'self-hosted' && (
          <span className="form-hint">Enter one or more seed brokers, e.g. broker-1:9092,broker-2:9092</span>
        )}
      </div>

      {mode === 'byoc' ? (
        <>
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            BYOC clusters always use TLS and SASL/SCRAM-SHA-256.
          </div>
          <div className="form-group">
            <label className="form-label">SASL Username</label>
            <input className="form-input" value={username} onChange={e => setUsername(e.target.value)} />
          </div>
          <PasswordField
            label="SASL Password"
            hasSaved={hasSavedPassword}
            value={password}
            onChange={v => { setPassword(v); setPasswordChanged(true) }}
          />
        </>
      ) : (
        <>
          <Toggle
            checked={tlsEnabled}
            onChange={setTlsEnabled}
            label="TLS"
          />
          <div className="mt-12">
            <Toggle
              checked={saslEnabled}
              onChange={setSaslEnabled}
              label="SASL"
            />
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
        </>
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

function PrometheusTab({ initial, clusterMode, onChange }) {
  const [mode, setMode] = useState(initial?.mode || clusterMode || 'byoc')
  const [scrapeYaml, setScrapeYaml] = useState(initial?.scrape_yaml || '')
  const [scrapeTargets, setScrapeTargets] = useState(
    Array.isArray(initial?.scrape_targets)
      ? initial.scrape_targets.join(',')
      : (initial?.scrape_targets || '')
  )
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)

  function buildConfig() {
    if (mode === 'byoc') {
      return { mode: 'byoc', scrape_yaml: scrapeYaml, scrape_targets: null }
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
      setSaveMsg({ type: 'success', text: 'Prometheus configuration saved and applied.' })
    } catch (e) {
      setSaveMsg({ type: 'error', text: e.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="mode-tabs">
        <button className={`mode-tab${mode === 'byoc' ? ' active' : ''}`} onClick={() => setMode('byoc')}>
          BYOC (Redpanda Cloud)
        </button>
        <button className={`mode-tab${mode === 'self-hosted' ? ' active' : ''}`} onClick={() => setMode('self-hosted')}>
          Self-Hosted
        </button>
      </div>

      {mode === 'byoc' ? (
        <div className="form-group">
          <label className="form-label">Scrape Job YAML</label>
          <textarea
            className="form-textarea tall"
            value={scrapeYaml}
            onChange={e => setScrapeYaml(e.target.value)}
            placeholder={'- job_name: redpandaCloud-...\n  static_configs:\n    - targets: [...]\n  basic_auth:\n    username: prometheus\n    password: your-password\n  scheme: https'}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <span className="form-hint">
            Paste the scrape job YAML from Redpanda Cloud UI → Metrics → Prometheus.
          </span>
        </div>
      ) : (
        <div className="form-group">
          <label className="form-label">Scrape Targets</label>
          <input className="form-input" value={scrapeTargets} onChange={e => setScrapeTargets(e.target.value)}
            placeholder="broker-1:9644,broker-2:9644,broker-3:9644" />
          <span className="form-hint">
            Typically the same hosts as your seed brokers on the Prometheus metrics port (default 9644 for Redpanda).
          </span>
        </div>
      )}

      {saveMsg && (
        <div className={`alert alert-${saveMsg.type === 'success' ? 'success' : 'error'} mt-16`}>
          {saveMsg.text}
        </div>
      )}

      <div className="mt-20">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><span className="spinner" /> Saving…</> : 'Save & Apply'}
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
              Prometheus Configuration
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
              clusterMode={settings?.cluster?.mode}
              onChange={savePrometheus}
            />
          )}
        </div>
      </div>
    </div>
  )
}
