'use strict'

/**
 * Forward inbound WhatsApp text to SK11; returns reply text.
 */
async function forwardInbound(config, { from, text, messageId }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.sk11TimeoutMs)

  try {
    const res = await fetch(config.sk11InboundUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.bridgeSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, text, messageId }),
      signal: controller.signal,
    })

    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = json?.error || `SK11 HTTP ${res.status}`
      throw new Error(err)
    }
    if (typeof json.reply !== 'string' || !json.reply) {
      throw new Error('SK11 response missing reply')
    }
    return json.reply
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { forwardInbound }
