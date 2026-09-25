# WS-BOT

SK11_finance 的 **WhatsApp Web 閘道**（[whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js)）。

- 業務邏輯在 Railway 上的 [Sk11_finance](https://github.com/11theridings-hk/Sk11_finance)
- 本專案只負責：掃 QR 連線、收訊 → 轉發 SK11、依回覆發訊、以及讓 Railway 呼叫 `/api/send` 做提醒
- **建議跑在家用常開 iMac**（住宅 IP），用 Cloudflare Tunnel / Tailscale 接 Railway
- Meta Cloud API 程式保留在 SK11，審批通過後可切回

> 非官方客戶端，有帳號限流／封禁風險。僅供內部白名單、低頻使用。見可行性說明（Project docs）。

## 快速開始（macOS / iMac）

```bash
git clone https://github.com/11theridings-hk/WS-BOT.git
cd WS-BOT
cp .env.example .env
# 編輯 .env：BRIDGE_SECRET、SK11_INBOUND_URL

npm install
npm start
```

瀏覽器打開：

```text
http://127.0.0.1:8787/pair?token=<BRIDGE_SECRET>
```

用 WhatsApp → 已連結的裝置 → 掃描 QR。

詳細步驟（防睡眠、Tunnel、launchd）：[`docs/imac-deploy.md`](./docs/imac-deploy.md)

## 與 SK11 對接

| 方向 | 端點 |
|------|------|
| 閘道 → SK11 | `POST {SK11_INBOUND_URL}` Bearer `BRIDGE_SECRET`，body `{ from, text, messageId? }` → `{ ok, reply }` |
| SK11 → 閘道 | `POST /api/send` Bearer 同密鑰，body `{ to, body }` |

Railway SK11 環境變數：

```env
WHATSAPP_PROVIDER=gateway
WHATSAPP_BRIDGE_SECRET=與閘道 BRIDGE_SECRET 相同
WHATSAPP_GATEWAY_URL=https://你的-tunnel-網域
WHATSAPP_ALLOWED_PHONES=8529xxxxxxx
```

## HTTP 一覽

| 路徑 | 認證 | 說明 |
|------|------|------|
| `GET /health` | 無 | 存活與 ready |
| `GET /pair?token=` | token | QR 配對頁 |
| `GET /status` | Bearer | JSON 狀態含 QR |
| `POST /api/send` | Bearer | 出站發訊 |

預設只聽 `127.0.0.1`——請用 Tunnel，勿 port forward 到公網。

## 環境變數

見 [`.env.example`](./.env.example)。
