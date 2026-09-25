'use strict'

const path = require('path')
const qrcodeTerminal = require('qrcode-terminal')
const QRCode = require('qrcode')
const { Client, LocalAuth } = require('whatsapp-web.js')
const { forwardInbound } = require('./sk11')
const { createSendGate } = require('./rateLimit')

/**
 * @param {ReturnType<import('./config').loadConfig>} config
 */
function createWhatsAppRuntime(config) {
  /** @type {{ ready: boolean, qr: string | null, qrDataUrl: string | null, me: string | null, lastError: string | null, lastInboundAt: string | null }} */
  const state = {
    ready: false,
    qr: null,
    qrDataUrl: null,
    me: null,
    lastError: null,
    lastInboundAt: null,
  }

  const sendGate = createSendGate(config.sendGapMs)
  /** @type {import('whatsapp-web.js').Client | null} */
  let client = null
  /** @type {Set<string>} */
  const recentIds = new Set()

  function rememberMessageId(id) {
    if (!id) return false
    if (recentIds.has(id)) return true
    recentIds.add(id)
    if (recentIds.size > 500) {
      const first = recentIds.values().next().value
      recentIds.delete(first)
    }
    return false
  }

  function phoneFromChatId(chatId) {
    // "85291234567@c.us" → "85291234567"
    return String(chatId || '')
      .split('@')[0]
      .replace(/\D/g, '')
  }

  async function sendText(toDigits, body) {
    if (!client || !state.ready) {
      return { ok: false, error: 'WhatsApp client not ready' }
    }
    const digits = String(toDigits || '').replace(/\D/g, '')
    if (!digits) return { ok: false, error: 'Invalid recipient' }
    const text = body.length > 4000 ? `${body.slice(0, 3990)}…` : body
    const chatId = `${digits}@c.us`

    return sendGate(async () => {
      try {
        const msg = await client.sendMessage(chatId, text)
        return { ok: true, messageId: msg?.id?._serialized || msg?.id?.id }
      } catch (e) {
        const err = e instanceof Error ? e.message : 'send failed'
        state.lastError = err
        return { ok: false, error: err }
      }
    })
  }

  function isPhoneAllowed(digits) {
    if (!config.allowedPhones) return true
    if (config.allowedPhones.has(digits)) return true
    return [...config.allowedPhones].some(
      (p) => digits === p || digits.endsWith(p) || p.endsWith(digits),
    )
  }

  async function handleIncoming(msg) {
    try {
      if (msg.fromMe) return
      if (msg.isStatus) return
      // groups: skip for finance bot
      if (String(msg.from || '').endsWith('@g.us')) return

      const messageId = msg.id?._serialized || msg.id?.id || ''
      if (rememberMessageId(messageId)) return

      const from = phoneFromChatId(msg.from)
      if (!from) return
      if (!isPhoneAllowed(from)) {
        console.warn('[wa] ignored non-allowlisted', from)
        return
      }

      const text = (msg.body || '').trim()
      if (!text) {
        await sendText(from, '目前只支援文字指令。請傳送「幫助」。')
        return
      }

      state.lastInboundAt = new Date().toISOString()
      console.log('[wa] inbound', from, text.slice(0, 80))

      let reply
      try {
        reply = await forwardInbound(config, { from, text, messageId })
      } catch (e) {
        const err = e instanceof Error ? e.message : 'SK11 error'
        console.error('[wa] SK11 forward failed', err)
        reply = '系統暫時無法處理，請稍後再試或登入網頁操作。'
      }

      const sent = await sendText(from, reply)
      if (!sent.ok) console.error('[wa] reply send failed', sent.error)
    } catch (e) {
      console.error('[wa] handleIncoming error', e)
    }
  }

  function start() {
    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.resolve(process.cwd(), config.dataPath),
        clientId: 'sk11-ws-bot',
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    })

    client.on('qr', async (qr) => {
      state.ready = false
      state.qr = qr
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 280 })
      } catch {
        state.qrDataUrl = null
      }
      console.log('[wa] Scan QR with WhatsApp → Linked devices')
      qrcodeTerminal.generate(qr, { small: true })
    })

    client.on('authenticated', () => {
      console.log('[wa] authenticated')
      state.qr = null
      state.qrDataUrl = null
    })

    client.on('ready', async () => {
      state.ready = true
      state.qr = null
      state.qrDataUrl = null
      state.lastError = null
      try {
        const wid = client.info?.wid?.user
        state.me = wid ? String(wid) : null
      } catch {
        state.me = null
      }
      console.log('[wa] ready', state.me || '')
    })

    client.on('auth_failure', (msg) => {
      state.ready = false
      state.lastError = `auth_failure: ${msg}`
      console.error('[wa] auth_failure', msg)
    })

    client.on('disconnected', (reason) => {
      state.ready = false
      state.lastError = `disconnected: ${reason}`
      console.warn('[wa] disconnected', reason)
    })

    client.on('message', (msg) => {
      void handleIncoming(msg)
    })

    client.initialize().catch((e) => {
      state.lastError = e instanceof Error ? e.message : String(e)
      console.error('[wa] initialize failed', e)
    })
  }

  return {
    start,
    getState: () => ({ ...state }),
    sendText,
  }
}

module.exports = { createWhatsAppRuntime }
