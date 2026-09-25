'use strict'

function required(name) {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

function parsePhoneList(raw) {
  if (!raw || !raw.trim()) return null
  const set = new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.replace(/\D/g, ''))
      .filter(Boolean),
  )
  return set.size > 0 ? set : null
}

function loadConfig() {
  return {
    bridgeSecret: required('BRIDGE_SECRET'),
    sk11InboundUrl: required('SK11_INBOUND_URL'),
    port: Number(process.env.PORT || 8787),
    host: process.env.HOST?.trim() || '127.0.0.1',
    dataPath: process.env.WWEBJS_DATA_PATH?.trim() || '.wwebjs_auth',
    allowedPhones: parsePhoneList(process.env.ALLOWED_PHONES),
    sendGapMs: Math.max(0, Number(process.env.SEND_GAP_MS || 1500)),
    sk11TimeoutMs: Math.max(5000, Number(process.env.SK11_TIMEOUT_MS || 30000)),
  }
}

module.exports = { loadConfig }
