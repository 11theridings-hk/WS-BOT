'use strict'

/**
 * Simple serial gap between outbound sends (reduces bursty automation signals).
 */
function createSendGate(gapMs) {
  let chain = Promise.resolve()
  let lastAt = 0

  return function enqueue(fn) {
    const run = async () => {
      const wait = Math.max(0, gapMs - (Date.now() - lastAt))
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastAt = Date.now()
      return fn()
    }
    const p = chain.then(run, run)
    chain = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }
}

module.exports = { createSendGate }
