'use strict'

const fs = require('fs')
const path = require('path')

// Load .env if present (no dotenv dependency)
function loadDotEnv() {
  const p = path.join(process.cwd(), '.env')
  if (!fs.existsSync(p)) return
  const text = fs.readFileSync(p, 'utf8')
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

loadDotEnv()

const { loadConfig } = require('./config')
const { createWhatsAppRuntime } = require('./waClient')
const { createServer } = require('./server')

async function main() {
  const config = loadConfig()
  const wa = createWhatsAppRuntime(config)
  const app = createServer(config, wa)

  await new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      console.log(`[ws-bot] listening http://${config.host}:${config.port}`)
      console.log(`[ws-bot] pair page: /pair?token=***`)
      console.log(`[ws-bot] health: /health`)
      resolve()
    })
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(
          `[ws-bot] fatal: ${config.host}:${config.port} already in use (EADDRINUSE).` +
            ' Kill the old process before restart, e.g.:\n' +
            `  lsof -nP -iTCP:${config.port} -sTCP:LISTEN\n` +
            '  kill <PID>\n' +
            '  launchctl kickstart -k gui/$(id -u)/hk.11theridings.ws-bot-gateway',
        )
      }
      reject(err)
    })
  })

  wa.start()
}

main().catch((e) => {
  console.error('[ws-bot] fatal', e)
  process.exit(1)
})
