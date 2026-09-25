'use strict'

const path = require('path')
const qrcodeTerminal = require('qrcode-terminal')
const QRCode = require('qrcode')
const { Client, LocalAuth } = require('whatsapp-web.js')
const { forwardInbound } = require('./sk11')
const { createSendGate } = require('./rateLimit')

/**
 * @param {ReturnType<typeof import('./config').loadConfig>} config
 */
function createWhatsAppRuntime(config) {
  /** @type {{ ready: boolean, qr: string | null, qrDataUrl: string | null, me: string | null, lastError: string | null, lastInboundAt: string | null, lastInboundFrom: string | null }} */
  const state = {
    ready: false,
    qr: null,
    qrDataUrl: null,
    me: null,
    lastError: null,
    lastInboundAt: null,
    lastInboundFrom: null,
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

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '')
  }

  function isLidJid(value) {
    return String(value || '').includes('@lid')
  }

  /**
   * Extract E.164-ish digits from chat id / PN fields.
   * Never treat `@lid` identifiers as phone numbers (that was forwarding
   * LID ids like 9761… to SK11 → allowlist deny → silent no-reply).
   */
  function phoneFromValue(value, lidDigitsToReject = '') {
    const raw = String(value || '').trim()
    if (!raw || isLidJid(raw)) return ''
    const user = raw.includes('@') ? raw.split('@')[0] : raw
    const base = user.split(':')[0]
    const d = digitsOnly(base)
    if (d.length < 8 || d.length > 15) return ''
    if (lidDigitsToReject && d === lidDigitsToReject) return ''
    return d
  }

  /**
   * Resolve real phone digits for SK11 binding / allowlist.
   * @param {import('whatsapp-web.js').Message} msg
   */
  async function resolveSenderPhone(msg) {
    const from = String(msg.from || '')
    const lidDigits = isLidJid(from) ? digitsOnly(from.split('@')[0]) : ''
    const data = msg._data || {}

    /** @type {{ phone: string, via: string }[]} */
    const found = []
    const consider = (value, via) => {
      const phone = phoneFromValue(value, lidDigits)
      if (phone) found.push({ phone, via })
    }

    consider(from, 'from')
    for (const key of ['senderPn', 'peerRecipientPn', 'recipientPn']) {
      consider(data[key], key)
    }

    try {
      if (client && typeof client.getContactLidAndPhone === 'function' && lidDigits) {
        const rows = await client.getContactLidAndPhone([from])
        for (const row of rows || []) {
          consider(row?.pn || row?.phone || row?.pnJid || row, 'getContactLidAndPhone')
        }
      }
    } catch (e) {
      console.warn(
        '[wa] getContactLidAndPhone failed',
        e instanceof Error ? e.message : e,
      )
    }

    try {
      const contact = await msg.getContact()
      const ser = String(contact?.id?._serialized || '')
      if (!isLidJid(ser)) {
        consider(contact?.number, 'contact.number')
        consider(contact?.id?.user, 'contact.user')
      }
      if (typeof contact?.getFormattedNumber === 'function') {
        consider(await contact.getFormattedNumber(), 'contact.formatted')
      }
    } catch (e) {
      console.warn('[wa] getContact phone resolve failed', e instanceof Error ? e.message : e)
    }

    if (found.length) {
      console.log('[wa] resolved phone', found[0].phone, 'via', found[0].via, 'chat=', from)
      return found[0].phone
    }

    console.warn('[wa] could not resolve PN', {
      from,
      senderPn: data.senderPn || null,
      peerRecipientPn: data.peerRecipientPn || null,
    })
    return ''
  }

  /**
   * Low-level send — must only be called from inside sendGate (no nested gate).
   * @param {string} text
   * @param {{ chatId?: string, toDigitsOrJid?: string }} opts
   */
  async function sendUnlocked(text, opts = {}) {
    if (!client || !state.ready) {
      return { ok: false, error: 'WhatsApp client not ready' }
    }
    const raw = String(opts.toDigitsOrJid || '').trim()
    const preferred = opts.chatId ? String(opts.chatId) : ''
    const digits = digitsOnly(raw.includes('@') ? raw.split('@')[0] : raw)

    const attempts = []
    if (preferred) attempts.push(preferred)
    if (raw.includes('@')) attempts.push(raw)
    // Avoid bare @c.us first when we already have a preferred LID/chat JID —
    // WhatsApp often throws "No LID for user" for stale @c.us mapping.
    if (digits && !preferred) attempts.push(`${digits}@c.us`)

    let lastErr = 'send failed'
    for (const chatId of [...new Set(attempts)]) {
      try {
        const msg = await client.sendMessage(chatId, text)
        return { ok: true, messageId: msg?.id?._serialized || msg?.id?.id }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : 'send failed'
        console.warn('[wa] send attempt failed', chatId, lastErr)
      }
    }

    // Resolve official WID (handles LID mapping)
    if (digits && client.getNumberId) {
      try {
        const wid = await client.getNumberId(digits)
        const jid = wid?._serialized || (wid?.user ? `${wid.user}@${wid.server || 'c.us'}` : '')
        if (jid) {
          const msg = await client.sendMessage(jid, text)
          return { ok: true, messageId: msg?.id?._serialized || msg?.id?.id }
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : lastErr
        console.warn('[wa] getNumberId send failed', lastErr)
      }
    }

    // Last resort: classic @c.us even when preferred chat was tried
    if (digits && preferred) {
      try {
        const msg = await client.sendMessage(`${digits}@c.us`, text)
        return { ok: true, messageId: msg?.id?._serialized || msg?.id?.id }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : lastErr
      }
    }

    state.lastError = lastErr
    return { ok: false, error: lastErr }
  }

  /**
   * Outbound send for API /api/send. Single sendGate — never nest.
   * @param {string} toDigitsOrJid
   * @param {string} body
   * @param {{ chatId?: string }} [opts]
   */
  async function sendText(toDigitsOrJid, body, opts = {}) {
    const text = body.length > 4000 ? `${body.slice(0, 3990)}…` : body
    return sendGate(() =>
      sendUnlocked(text, { toDigitsOrJid, chatId: opts.chatId }),
    )
  }

  /**
   * Prefer Message#reply / chat.sendMessage so WhatsApp uses the same thread (LID-safe).
   * Fallback uses sendUnlocked inside the SAME gate — never nest sendGate (deadlock).
   * @param {import('whatsapp-web.js').Message} msg
   * @param {string} body
   */
  async function replyToMessage(msg, body) {
    const text = body.length > 4000 ? `${body.slice(0, 3990)}…` : body
    return sendGate(async () => {
      try {
        if (typeof msg.reply === 'function') {
          const sent = await msg.reply(text)
          return { ok: true, messageId: sent?.id?._serialized || sent?.id?.id }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : 'reply failed'
        console.warn('[wa] msg.reply failed, trying getChat', err)
      }

      try {
        if (typeof msg.getChat === 'function') {
          const chat = await msg.getChat()
          if (chat && typeof chat.sendMessage === 'function') {
            const sent = await chat.sendMessage(text)
            return { ok: true, messageId: sent?.id?._serialized || sent?.id?.id }
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : 'chat.sendMessage failed'
        console.warn('[wa] chat.sendMessage failed, falling back', err)
      }

      const phone = await resolveSenderPhone(msg)
      return sendUnlocked(text, {
        toDigitsOrJid: phone || msg.from,
        chatId: msg.from,
      })
    })
  }

  function isPhoneAllowed(digits) {
    if (!config.allowedPhones) return true
    if (!digits) return false
    if (config.allowedPhones.has(digits)) return true
    return [...config.allowedPhones].some(
      (p) => digits === p || digits.endsWith(p) || p.endsWith(digits),
    )
  }

  async function handleIncoming(msg) {
    try {
      if (msg.fromMe) return
      if (msg.isStatus) return
      // groups: broadcast-only — no interactive replies in groups
      if (String(msg.from || '').endsWith('@g.us')) return

      const messageId = msg.id?._serialized || msg.id?.id || ''
      if (rememberMessageId(messageId)) return

      const from = await resolveSenderPhone(msg)
      if (!from) {
        console.warn('[wa] could not resolve sender phone from', msg.from, 'dataKeys=', Object.keys(msg._data || {}))
        return
      }
      if (!isPhoneAllowed(from)) {
        console.warn('[wa] ignored non-allowlisted', from)
        return
      }

      const text = (msg.body || '').trim()
      if (!text) {
        await replyToMessage(msg, '目前只支援文字指令。請傳送「幫助」或 help。')
        return
      }

      state.lastInboundAt = new Date().toISOString()
      state.lastInboundFrom = from
      console.log('[wa] inbound', from, text.slice(0, 80), 'chat=', msg.from)

      let reply
      try {
        reply = await forwardInbound(config, { from, text, messageId })
      } catch (e) {
        const err = e instanceof Error ? e.message : 'SK11 error'
        console.error('[wa] SK11 forward failed', err)
        reply =
          '系統暫時無法處理，請稍後再試或登入網頁操作。\n' +
          'System temporarily unavailable. Please try again or use the web app.'
        if (/Unauthorized|401/i.test(err)) {
          console.error('[wa] hint: check BRIDGE_SECRET matches Railway WHATSAPP_BRIDGE_SECRET')
        }
      }

      // null = SK11 ignored (allowlist) — do not send WhatsApp reply
      if (reply == null) {
        console.log('[wa] SK11 ignored inbound; no reply sent', from)
        return
      }

      const sent = await replyToMessage(msg, reply)
      if (!sent.ok) {
        console.error('[wa] reply send failed', sent.error)
        state.lastError = sent.error || state.lastError
      } else if (state.lastError && /No LID/i.test(state.lastError)) {
        state.lastError = null
      }
    } catch (e) {
      console.error('[wa] handleIncoming error', e)
      state.lastError = e instanceof Error ? e.message : String(e)
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
