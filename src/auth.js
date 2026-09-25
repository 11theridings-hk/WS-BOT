'use strict'

const { timingSafeEqual } = require('crypto')

function extractBearer(req) {
  const h = req.headers.authorization || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  const alt = req.headers['x-bridge-secret']
  return typeof alt === 'string' ? alt.trim() : ''
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8')
  const bufB = Buffer.from(b || '', 'utf8')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

function requireBridgeSecret(secret) {
  return (req, res, next) => {
    const provided = extractBearer(req)
    if (!safeEqual(provided, secret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' })
    }
    return next()
  }
}

module.exports = { requireBridgeSecret, extractBearer, safeEqual }
