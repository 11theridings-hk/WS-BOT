# 家用 iMac 部署指南（WS-BOT）

目標：在常開 iMac 上跑閘道，用 **住宅寬頻 IP** 連 WhatsApp Web，並以 Tunnel 讓 Railway SK11 安全呼叫 `/api/send`。

## 1. 前置

- macOS、已安裝 [Node.js 20+](https://nodejs.org/)
- 一支**專用** WhatsApp 號碼（勿用個人主號）
- Railway 上 SK11 已部署且可設環境變數
- （建議）Cloudflare 帳號，或 Tailscale

## 2. 安裝與首次連線

```bash
cd ~/Projects   # 或你習慣的目錄
git clone https://github.com/11theridings-hk/WS-BOT.git
cd WS-BOT
cp .env.example .env
```

編輯 `.env`：

```env
BRIDGE_SECRET=請用長隨機字串
SK11_INBOUND_URL=https://sk11finance.up.railway.app/api/internal/whatsapp/inbound
PORT=8787
HOST=127.0.0.1
WWEBJS_DATA_PATH=.wwebjs_auth
# ALLOWED_PHONES=8529xxxxxxx
SEND_GAP_MS=1500
```

```bash
npm install
npm start
```

本機打開 `http://127.0.0.1:8787/pair?token=<BRIDGE_SECRET>`，手機掃 QR。

成功後 terminal 會出現 `ready`；`.wwebjs_auth/` 會寫入 session——**請納入備份**（Time Machine 或定期拷貝）。

## 3. 防止睡眠

系統設定 → 鎖定畫面／節能：

- 接電源時：**防止自動進入睡眠**（或將「關閉顯示器」與電腦睡眠分開，確保電腦不睡）
- 可選終端常駐：`caffeinate -dims &`（測試用）

## 4. 用 Cloudflare Tunnel 暴露給 Railway（建議）

**不要**在路由器做 port forward。

1. 安裝 `cloudflared`（Homebrew：`brew install cloudflare/cloudflare/cloudflared`）
2. `cloudflared tunnel login`
3. 建立 tunnel 並指向本機：

```bash
cloudflared tunnel create ws-bot
cloudflared tunnel route dns ws-bot wa-bot.yourdomain.com
```

設定檔示例（`~/.cloudflared/config.yml`）：

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: wa-bot.yourdomain.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel run ws-bot
```

Railway SK11：

```env
WHATSAPP_PROVIDER=gateway
WHATSAPP_BRIDGE_SECRET=與 BRIDGE_SECRET 相同
WHATSAPP_GATEWAY_URL=https://wa-bot.yourdomain.com
WHATSAPP_ALLOWED_PHONES=8529xxxxxxx
WHATSAPP_REMINDER_PHONES=8529xxxxxxx
```

> Meta 的 `WHATSAPP_VERIFY_TOKEN` / `ACCESS_TOKEN` 等可先不填；保留程式即可。

### Tailscale 替代

若 Railway 與 iMac 都在 Tailscale：把 `WHATSAPP_GATEWAY_URL` 設成 `http://100.x.x.x:8787`（MagicDNS 名稱亦可）。Railway 需能連到 Tailscale 網路（例如 subnet router／sidecar）；多數情況 **Cloudflare Tunnel 更簡單**。

## 5. 開機自啟（launchd）

建立 `~/Library/LaunchAgents/hk.11theridings.ws-bot.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>hk.11theridings.ws-bot</string>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/WS-BOT</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>src/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/WS-BOT/logs/out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/WS-BOT/logs/err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

```bash
mkdir -p ~/WS-BOT/logs
# 修正 plist 內路徑與 node 路徑：which node
launchctl load ~/Library/LaunchAgents/hk.11theridings.ws-bot.plist
```

Tunnel 可另做一個 LaunchAgent 跑 `cloudflared tunnel run ws-bot`。

## 6. 驗證

1. `curl -s http://127.0.0.1:8787/health` → `ready: true`
2. 白名單號碼傳 `幫助` 給閘道綁定的 WhatsApp
3. Railway 日誌應看到入站；手機收到回覆
4. （可選）測提醒：觸發 cron 或手動打 SK11 提醒流程

## 7. 營運注意

- 僅內部白名單；勿群發
- 掉線時看 `/pair` 是否重新出現 QR
- 升級：`git pull && npm install &&` 重啟（先確認 wwebjs changelog）
- Meta 審批通過後：SK11 改 `WHATSAPP_PROVIDER=cloud` 並填官方變數，可停掉本閘道

## 8. 故障排查

| 現象 | 檢查 |
|------|------|
| 一直 QR | 手機網路、刪除舊「已連結裝置」後重掃；清 `.wwebjs_auth` 再試（會重登） |
| ready 但無回覆 | `SK11_INBOUND_URL`、Railway 密鑰、SK11 是否已部署 inbound API |
| `/health` 有 `lastError: No LID for user` | WhatsApp LID 問題；請更新本倉庫（`msg.reply` + `getNumberId` 後備）後重啟閘道 |
| Railway 提醒發不出 | `WHATSAPP_GATEWAY_URL`、Tunnel、Bearer 密鑰 |
| Chromium 起不來 | `npm install` 完整；macOS 允許相關權限 |
