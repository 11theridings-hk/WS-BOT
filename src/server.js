'use strict'

const express = require('express')
const { requireBridgeSecret } = require('./auth')

/**
 * @param {ReturnType<import('./config').loadConfig>} config
 * @param {ReturnType<import('./waClient').createWhatsAppRuntime>} wa
 */
function createServer(config, wa) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '64kb' }))

  app.get('/health', (_req, res) => {
    const s = wa.getState()
    res.json({
      ok: true,
      ready: s.ready,
      me: s.me,
      lastInboundAt: s.lastInboundAt,
      lastError: s.lastError,
    })
  })

  app.get('/status', requireBridgeSecret(config.bridgeSecret), (_req, res) => {
    const s = wa.getState()
    res.json({
      ok: true,
      ready: s.ready,
      me: s.me,
      hasQr: Boolean(s.qr),
      qr: s.qr,
      qrDataUrl: s.qrDataUrl,
      lastInboundAt: s.lastInboundAt,
      lastError: s.lastError,
    })
  })

  /** Simple pairing page (secret via query for local/tunnel use). */
  app.get('/pair', (req, res) => {
    const token = String(req.query.token || '')
    if (token !== config.bridgeSecret) {
      res.status(401).type('html').send('<h1>Unauthorized</h1><p>Need ?token=BRIDGE_SECRET</p>')
      return
    }
    const s = wa.getState()
    const img = s.qrDataUrl
      ? `<img alt="QR" src="${s.qrDataUrl}" width="280" height="280" />`
      : s.ready
        ? '<p>Already linked. No QR needed.</p>'
        : '<p>Waiting for QR… refresh in a few seconds.</p>'

    res.type('html').send(`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="15" />
  <title>WS-BOT Pairing</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; }
    code { background: #f2f2f2; padding: 0.1rem 0.3rem; }
  </style>
</head>
<body>
  <h1>SK11 WhatsApp 閘道</h1>
  <p>狀態：<strong>${s.ready ? '已連線' : '未連線'}</strong>${s.me ? `（${s.me}）` : ''}</p>
  ${img}
  <p>手機 WhatsApp → 設定 → 已連結的裝置 → 連結裝置，掃描上方 QR。</p>
  <p style="color:#666;font-size:0.9rem">此頁每 15 秒自動刷新。勿把含 token 的網址分享給外人。</p>
</body>
</html>`)
  })

  app.post('/api/send', requireBridgeSecret(config.bridgeSecret), async (req, res) => {
    const to = req.body?.to
    const body = req.body?.body
    if (!to || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ ok: false, error: 'Need { to, body }' })
    }
    const result = await wa.sendText(to, body.trim())
    return res.status(result.ok ? 200 : 503).json(result)
  })

  return app
}

module.exports = { createServer }
