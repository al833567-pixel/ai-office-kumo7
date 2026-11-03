# AI 辦公室（Office Hub）

讓兩台電腦上的 Claude Code 和 Hermes 組成一個團隊：你在任一台的 Claude Code 輸入 `/office 目標`，那台的 Claude 就當主管，拆任務派給其他人。進度、回報、檔案都經過家裡電腦上的 Hub，像素辦公室 UI 即時顯示每個人在做什麼。

```
                  Tailscale 內網（不開對外 port）
┌──────────────────── 家裡電腦：Office Hub（src/）────────────────────┐
│ /bot<token>/…  Telegram Bot API 相容 + 任務擴充   /mcp  MCP 入口      │
│ /hooks  Claude Code 狀態   /ws  UI 即時事件   /  像素辦公室 UI        │
│ SQLite：帳號、群組、訊息、更新佇列、目標、任務、檔案、事件            │
└──────────────────────────────────────────────────────────────────────┘
      ▲ getUpdates / MCP / hooks                    ▲
┌─────┴──── A 機（家裡電腦）────┐        ┌──────────┴──── B 機 ─────────┐
│ Claude Code + office 頻道外掛  │        │ Claude Code + office 頻道外掛 │
│ office run（Hermes 接線）      │        │ office run（Hermes 接線）     │
└────────────────────────────────┘        └───────────────────────────────┘
```

| 資料夾 | 內容 |
|---|---|
| `src/` | Hub 伺服器 |
| `ui/index.html` | 像素辦公室 UI（Hub 首頁） |
| `claude/` | Claude Code 本機 marketplace：`office` 頻道外掛（改寫自官方 Telegram 外掛）＋ `/office` skill |
| `node/` | 每台 agent 機器用的 `office` 指令（Hermes 接線、檔案上傳下載、設定 Claude） |
| `test/` | 49 項測試（含真正的 grammY、官方 MCP SDK、外掛端對端、假 Hermes 全流程） |

## 需求

- 每台機器：[Bun](https://bun.sh) 1.1 以上、[Tailscale](https://tailscale.com)
- Agent 機器：Claude Code（用 claude.ai 帳號登入；頻道功能需要）、Hermes Agent
- Claude Code 頻道（channels）目前是研究預覽功能。個人 Pro/Max 可直接用；Team/Enterprise 要管理員先開啟。自製頻道每次啟動都會出現一次「開發者頻道」確認畫面。

---

## 一、家裡電腦：架 Hub

```bash
cd office-hub
bun install
bun run init
```

`init` 建立資料庫與 5 個帳號，印出 token（也存在 `data/tokens.local.json`）：

| 帳號 | 類型 | 機器 |
|---|---|---|
| `boss` | 你（真人，登入 UI 用） | — |
| `claude_a` / `hermes_a` | Claude / Hermes | A（家裡電腦） |
| `claude_b` / `hermes_b` | Claude / Hermes | B |

啟動 Hub，綁在家裡電腦的 Tailscale IP（用 `tailscale ip -4` 查）：

```bash
HUB_HOST=100.x.y.z bun run start
```

用瀏覽器開 `http://100.x.y.z:7070/`，貼上 `boss` 的 token 登入。

要開機自動啟動，Linux 可用 systemd：

```ini
# /etc/systemd/system/office-hub.service
[Unit]
Description=Office Hub
After=network-online.target tailscaled.service

[Service]
WorkingDirectory=/path/to/office-hub
Environment=HUB_HOST=100.x.y.z
ExecStart=/home/you/.bun/bin/bun run src/server.ts
Restart=always
User=you

[Install]
WantedBy=multi-user.target
```

Mac 可用 launchd，Windows 可用 NSSM 包成服務。

### Hub 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `HUB_HOST` | `127.0.0.1` | 綁定位址。請用 Tailscale IP，不要用 `0.0.0.0` |
| `HUB_PORT` | `7070` | 連接埠 |
| `HUB_DB` | `data/office.db` | 資料庫；檔案存在旁邊的 `files/` |
| `HUB_LEASE_MIN` | `15` | 任務租約分鐘數，超過沒回報進度就退回待辦 |
| `HUB_STALL_MIN` | `5` | 做任務時超過幾分鐘沒動靜算「卡住」 |
| `HUB_OFFLINE_SEC` | `120` | 超過幾秒沒連線算「離線」 |
| `HUB_LOOP_LIMIT` | `30` | 同一串對話 bot 之間來回幾次就暫停，等你發言 |
| `HUB_LOG` | `1` | 設 `0` 關閉請求紀錄 |

---

## 二、每台 agent 機器（A、B 都要做）

### 1. 放好 office 指令

把整個 `office-hub` 資料夾複製到這台機器（或 git clone），把 `node/` 加進 PATH：

```bash
export PATH="/path/to/office-hub/node:$PATH"
```

Windows 用 `node\office.cmd`。

### 2. 寫設定檔 `~/.office/config.json`

複製 `node/config.example.json` 修改：

- `hub`：Hub 網址，例如 `http://100.x.y.z:7070`
- `machine`：`A` 或 `B`
- `claude_token` / `hermes_token`：這台機器那兩個帳號的 token
- `approvers`：可以批准權限的真人帳號 id（`boss` 預設是 `1000000001`）
- `hermes.mode`：
  - `cli`（預設）：每個任務執行一次 `hermes chat -Q -q "<提示>"`，可用 `hermes.cmd` 改指令
  - `api`：呼叫 Hermes API server（`hermes gateway` 開的 `:8642`），要填 `api_url`、`api_key`

檢查：

```bash
office doctor
```

### 3. 啟動 Hermes 接線（常駐）

```bash
office run
```

它會：送心跳（UI 才會顯示在線）、收 `@hermes_x` 的派工 → 領取任務 → 執行 Hermes → 跑驗收指令 → 上傳 `$OFFICE_OUT` 裡的檔案 → 回報，執行中每 30 秒更新進度並延長租約。真人在群組 @ 它聊天時，它會用 Hermes 回答。

建議也用 systemd / launchd 讓它常駐。

### 4. 設定 Claude Code

```bash
office setup-claude
```

它會寫入 `~/.claude/channels/office/.env`、`access.json`（允許其他 agent 與你傳訊息，只有 `approvers` 能批准權限），並安裝 `/office` skill。接著照它印出的三行指令做（只需一次）：

```bash
claude plugin marketplace add "/path/to/office-hub/claude"
```

```bash
claude plugin install office@office-local
```

```bash
claude mcp add --transport http --scope user office-hub http://100.x.y.z:7070/mcp --header "Authorization: Bearer <這台的 claude token>"
```

### 5. 啟動辦公室用的 Claude Code

```bash
office-claude
```

這等於 `OFFICE_SESSION=1 claude --dangerously-load-development-channels plugin:office@office-local`。第一次會出現開發者頻道的確認畫面，選「I am using this for local development」。

只有這個 session 會連 Hub；你平常開的 `claude` 不受影響。建議開在 tmux 裡讓它一直在線（頻道只在 session 開著時收得到訊息）。

為了不被權限提示卡住，建議先把常用指令加進允許清單，或用 auto 模式。卡住時 UI 會顯示「等你批准」，你也可以直接在 UI 的「私訊／批准」按允許。

---

## 三、使用

### 交給團隊

在任一台的 office Claude Code 輸入：

```
/office 把 B 機的 nginx log 每天壓縮備份，並寫一個查詢 404 的小工具
```

這台的 Claude 會當主管：開目標 → 看誰空閒 → 拆任務派工（Hermes 拿單一可驗證的工作，程式交給 Claude）→ 收回報、審查 → 下載檔案 → 在這個 session 跟你報告。另一個 Claude 自動當審查者。

也可以在 UI 上方輸入目標，選主管（自動／Claude-A／Claude-B）。自動規則：目標提到哪台機器就給那台的 Claude → 誰空閒 → 手上工作最少。

### UI

- **辦公室**：角色依狀態走到不同地方；點角色看動態（hooks、訊息、任務）
- **目標與任務**：看板；可以中止、重跑、改派
- **聊天**：office 群組（可選目標討論串，@ 人會叫到他）；「私訊／批准」裡有 Claude 送來的權限按鈕
- **通知**：右上角開啟桌面通知（任務完成或失敗、有人卡住或報錯、需要批准）

| 狀態 | 去哪裡 | 怎麼判斷 |
|---|---|---|
| 工作中 | 座位 | 有進行中的任務，或 hooks 回報正在用工具 |
| 開會／審查 | 會議室 | 是某個目標的主管或審查者，正在動作但沒有自己的任務 |
| 空閒 | 茶水間、娛樂室、休息區 | 在線但沒事 |
| 排隊 | 任務看板前 | 有待辦任務還沒開始 |
| 等你批准 | 座位 | Claude Code 跳出權限提示（Notification hook） |
| 卡住（偷懶） | 釣魚池摸魚 | 有進行中任務，但超過 `HUB_STALL_MIN` 沒動靜 |
| 報錯 | 座位冒煙 | Claude Code 回合因 API 錯誤結束（StopFailure hook） |
| 離線 | 不在辦公室 | 超過 `HUB_OFFLINE_SEC` 沒連線 |

### 任務規則

- 任務有租約（預設 15 分鐘），執行者要定期 `office_progress`；過期自動退回待辦並通知
- Hermes 失敗會自動重試；用完次數就自動改派給審查者 Claude
- `depends_on` 的任務在前置任務完成後才會派出
- 主管或審查者可以 `office_review` 退回
- 同一串對話 bot 之間來回超過上限會暫停，等你在 UI 發言

### 檔案

- 上傳：`office upload <檔案>` 印出 `file_id`，放進 `office_report` 的 `files`
- 下載：`office download <file_id> [目錄]`
- Hermes 任務把產出放在 `$OFFICE_OUT`，`office run` 會自動上傳
- UI 的📎可以直接下載

---

## 四、API

所有 agent 共用同一套方法，兩個入口：

- HTTP：`POST /bot<token>/<方法>`（你和 UI 用 `/user<token>/<方法>`），回應 `{"ok":true,"result":...}`，與 Telegram 相同
- MCP：`POST /mcp`，`Authorization: Bearer <token>`，工具背後呼叫相同方法

### Telegram 相容方法

`getMe`、`getUpdates`（長輪詢、offset）、`sendMessage`、`sendDocument`、`sendPhoto`、`getFile`（下載：`GET /file/bot<token>/<file_path>`）、`editMessageText`、`sendChatAction`、`setMessageReaction`、`answerCallbackQuery`、`setMyCommands`、`getMyCommands`、`deleteMyCommands`、`getChat`、`deleteWebhook`、`getWebhookInfo`

和 Telegram 不同的地方：

- bot 之間互相看得到訊息
- 訊息多一個 `data` 欄位放結構化資料（任務卡等）
- 沒給 `entities` 時，Hub 自動標出 `@username`
- 回覆訊息時沿用原訊息的討論串（`message_thread_id`）
- `chat_id` 可用 `@username`、`@office`（群組 id `-1001000000001`）
- 同一個 bot 重開長輪詢時，舊連線被接手並回空陣列，不回 409

### 擴充方法（HTTP 名稱 / MCP 工具）

| HTTP | MCP | 說明 |
|---|---|---|
| `createGoal` | `office_new_goal` | 開目標；bot 呼叫時自己當主管，真人可指定 `lead` 或 `auto` |
| `createTask` | `office_assign` | 主管派工：`assignee`、`title`、`instructions`、`verify`、`depends_on`、`max_attempts` |
| `claimTask` | `office_claim` | 執行者領取（原子操作），開始租約 |
| `progressTask` | `office_progress` | 回報進度並延長租約 |
| `reportTask` | `office_report` | `done` / `failed`，附結果與 `files` |
| `reviewTask` | `office_review` | 主管或審查者 `approve` / `reject` |
| `reassignTask` / `retryTask` / `cancelTask` | `office_reassign` / `office_retry` / `office_cancel` | 主管或真人 |
| `completeGoal` | `office_complete_goal` | 結束目標並附總結 |
| `getGoals` / `getTasks` / `getAgents` | `office_goals` / `office_tasks` / `office_agents` | 查詢 |
| `uploadFile` | — | 只上傳不發訊息 |
| `pressButton` | — | 真人按 bot 訊息上的按鈕（UI 批准權限用） |
| `heartbeat` | — | office-node 心跳 |
| — | `office_send`、`office_whoami`、`office_file_info` | 發訊息、身分、檔案資訊 |

---

## 五、安全

- Hub 只綁 Tailscale IP，不開對外 port
- 每個帳號一組 token，資料庫只存雜湊；`bun run cli token <帳號>` 可換新 token
- Claude Code 會把其他 agent 的訊息標示為「來自同事」，不是你的指令
- 權限批准只接受 `approvers` 裡的真人；其他 bot 回「yes 代碼」或按按鈕都無效（有測試）
- hooks 只送事件名稱、工具名稱和指令前 300 字，不送檔案內容與工具輸出

## 六、已知限制

- 頻道是研究預覽功能，旗標名稱和行為之後可能改變
- Hermes 本地模型能接多大的任務，取決於你的模型呼叫工具穩不穩；先從小任務開始
- `hermes chat -Q -q` 的參數依 Hermes 版本可能不同，用 `office doctor` 檢查，必要時改 `hermes.cmd` 或改用 `api` 模式
- 同一台機器同時開多個 office session 會共用同一個 Claude 帳號，請只開一個
- Hub 在家裡電腦，關機時整個系統停擺

## 七、開發與測試

```bash
bun install
(cd claude/office && bun install)
bun test
```

```bash
bun run cli list
bun run cli add codex_a --name Codex-A --kind other --machine A
```
