# AI 辦公室（Office Hub）

讓兩台 Windows 電腦上的 Claude Code 和（WSL 裡的）Hermes 組成一個團隊：你在任一台的 Claude Code 輸入 `/office 目標`，那台的 Claude 就當主管，拆任務派給其他人。進度、回報、檔案都經過家裡電腦上的 Hub，像素辦公室 UI 即時顯示每個人在做什麼。

```
                  Tailscale 內網（不開對外 port）
┌──────────────────── 家裡電腦：Office Hub（src/）────────────────────┐
│ /bot<token>/…  Telegram Bot API 相容 + 任務擴充   /mcp  MCP 入口      │
│ /hooks  Claude Code 狀態   /ws  UI 即時事件   /  像素辦公室 UI        │
│ SQLite：帳號、群組、訊息、更新佇列、目標、任務、檔案、事件            │
└──────────────────────────────────────────────────────────────────────┘
      ▲ getUpdates / MCP / hooks                    ▲
┌─────┴──── A 機（家裡電腦，Windows）─────┐   ┌────┴──── B 機（Windows）────┐
│ Claude Code + office 頻道外掛（claude_a）│   │ Claude Code + 頻道外掛       │
│ office-node（回報 Claude session）       │   │ （claude_b）＋ office-node   │
│ WSL：Hermes + office-node（hermes_a）    │   └──────────────────────────────┘
└──────────────────────────────────────────┘
```

| 資料夾 | 內容 |
|---|---|
| `src/` | Hub 伺服器 |
| `ui/index.html` | 像素辦公室 UI（Hub 首頁） |
| `claude/` | Claude Code 本機 marketplace：`office` 頻道外掛（改寫自官方 Telegram 外掛）＋ `/office` skill |
| `node/` | 每台 agent 機器用的 `office` 指令（Hermes 接線、檔案上傳下載、設定 Claude） |
| `scripts/windows/`、`scripts/wsl/` | Windows 啟動腳本、工作排程器註冊、WSL 啟動腳本與 systemd 服務 |
| `test/` | 50 項測試（含真正的 grammY、官方 MCP SDK、外掛端對端、假 Hermes 全流程），Windows 與 Linux 都能跑 |

## 需求

實際環境：兩台 Windows；家裡電腦（A 機）跑 Hub，Hermes 跑在 A 機的 WSL2 裡。

- 兩台 Windows：[Bun](https://bun.sh)（`winget install Oven-sh.Bun`）、Git、Claude Code（用 claude.ai 帳號登入；頻道功能需要）
- A 機的 WSL：Bun（`curl -fsSL https://bun.sh/install | bash`）、Hermes Agent
- 兩台之間：[Tailscale](https://tailscale.com)（只有一台時可以先不用）
- Claude Code 頻道（channels）目前是研究預覽功能。個人 Pro/Max 可直接用；Team/Enterprise 要管理員先開啟。自製頻道每次啟動都會出現一次「開發者頻道」確認畫面。

---

## 一、A 機（家裡電腦）：架 Hub

在專案資料夾（例如 `D:\AI home\ai-office-kumo7`）開終端機：

```bash
bun install
```

```bash
bun run init
```

`init` 建立資料庫與帳號，印出 token（也存在 `data\tokens.local.json`）：

| 帳號 | 類型 | 在哪 |
|---|---|---|
| `boss` | 你（真人，登入 UI 用） | — |
| `claude_a` | Claude | A 機 Windows |
| `claude_b` | Claude | B 機 Windows |
| `hermes_a` | Hermes | A 機 WSL |

舊版 `init` 會多建一個 `hermes_b`，用不到就停用：`bun run cli disable hermes_b`。

啟動 Hub：

```bash
scripts\windows\start-hub.cmd
```

預設只聽 `127.0.0.1:7070`，同一台的 Windows 與 WSL（mirrored 網路模式）都連得到。瀏覽器開 `http://127.0.0.1:7070/`，貼上 `boss` 的 token 登入。

要讓 B 機連進來時：登入 Tailscale，在專案根目錄建立 `hub.env.cmd`，寫一行 `set HUB_HOST=<A 機的 Tailscale IP>`（用 `tailscale ip -4` 查），重開 Hub。之後 A 機自己也改用這個 IP 連。

### Hub 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `HUB_HOST` | `127.0.0.1` | 綁定位址。對外請用 Tailscale IP，不要用 `0.0.0.0` |
| `HUB_PORT` | `7070` | 連接埠 |
| `HUB_DB` | `data/office.db` | 資料庫；檔案存在旁邊的 `files/` |
| `HUB_LEASE_MIN` | `15` | 任務租約分鐘數，超過沒回報進度就退回待辦 |
| `HUB_STALL_MIN` | `5` | 做任務時超過幾分鐘沒動靜算「卡住」 |
| `HUB_OFFLINE_SEC` | `120` | 超過幾秒沒連線算「離線」 |
| `HUB_LOOP_LIMIT` | `30` | 同一串對話 bot 之間來回幾次就暫停，等你發言 |
| `HUB_LOG` | `1` | 設 `0` 關閉請求紀錄 |

---

## 二、A 機的 WSL：接上 Hermes

### 1. 讓 WSL 連得到 Hub

在 Windows 的 `%USERPROFILE%\.wslconfig` 加上（沒有這個檔案就新建）：

```ini
[wsl2]
networkingMode=mirrored
```

然後在 PowerShell 執行 `wsl --shutdown` 讓設定生效。mirrored 模式下 WSL 和 Windows 共用網路，WSL 裡用 `http://127.0.0.1:7070` 就連得到 Hub，之後換成 Tailscale IP 也一樣連得到。

在 WSL 裡確認：

```bash
curl http://127.0.0.1:7070/health
```

### 2. 設定檔與檢查

WSL 可以直接用 Windows 上的專案（`/mnt/d/AI home/ai-office-kumo7`），或另外 `git clone` 一份到 WSL 家目錄（檔案存取比較快）。

```bash
mkdir -p ~/.office && cp node/config.wsl.example.json ~/.office/config.json
```

編輯 `~/.office/config.json`：填 `hermes_token`（`hermes_a` 的 token）。Hermes 的呼叫方式二選一：

- `cli`（預設）：每個任務執行一次 `hermes chat -Q -q "<提示>"`，可用 `hermes.cmd` 改指令
- `api`：呼叫 Hermes API server（`hermes gateway` 開的 `:8642`），填 `api_url`、`api_key`

```bash
bun node/office.ts doctor
```

### 3. 啟動 Hermes 接線

```bash
bash scripts/wsl/run-office-node.sh
```

日誌在 `~/.office/office-node.log`。它會：送心跳（UI 才會顯示 Hermes 在線）、收 `@hermes_a` 的派工 → 領取任務 → 執行 Hermes → 跑驗收指令 → 上傳 `$OFFICE_OUT` 裡的檔案 → 回報，執行中每 30 秒更新進度並延長租約。真人在群組 @ 它聊天時，它會用 Hermes 回答。

注意路徑：Hermes 在 WSL 裡看到的 Windows 檔案是 `/mnt/c/...`、`/mnt/d/...`。派工給 Hermes 時路徑要寫 WSL 格式（`/office` skill 已提醒主管）。

---

## 三、兩台 Windows：設定 Claude Code

以下 A、B 兩台各做一次（B 機先 `git clone` 專案、`bun install`）。

### 1. 設定檔

複製範例到 `%USERPROFILE%\.office\config.json`：A 機用 `node\config.windows-A.example.json`，B 機用 `node\config.windows-B.example.json`。填入這台的 `claude_token`；`hub` 在 A 機是 `http://127.0.0.1:7070`，B 機是 A 機的 Tailscale IP。

把 `node` 資料夾加進使用者 PATH（讓 Claude 能在終端機執行 `office upload`、`office download`）：

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";D:\AI home\ai-office-kumo7\node", "User")
```

重開終端機後檢查：

```bash
office doctor
```

### 2. 寫入 Claude 設定、安裝外掛與 MCP

```bash
office setup-claude
```

它會寫入 `%USERPROFILE%\.claude\channels\office\.env`、`access.json`（允許其他 agent 與你傳訊息，只有 `approvers` 能批准權限），並安裝 `/office` skill。接著照它印出的三行指令做（只需一次）：

```bash
claude plugin marketplace add "D:\AI home\ai-office-kumo7\claude"
```

```bash
claude plugin install office@office-local
```

```bash
claude mcp add --transport http --scope user office-hub http://127.0.0.1:7070/mcp --header "Authorization: Bearer <這台的 claude token>"
```

### 3. 啟動辦公室用的 Claude Code

```bash
node\office-claude.cmd
```

這等於設定 `OFFICE_SESSION=1` 後執行 `claude --dangerously-load-development-channels plugin:office@office-local`。第一次會出現開發者頻道的確認畫面，選「I am using this for local development」。

只有這個 session 會連 Hub；你平常開的 `claude` 不受影響。這個視窗要一直開著（頻道只在 session 開著時收得到訊息）。

為了不被權限提示卡住，建議先把常用指令加進允許清單，或用 auto 模式。卡住時 UI 會顯示「等你批准」，你也可以直接在 UI 的「私訊／批准」按允許。

### 4. Windows 端 office-node（回報 Claude session 狀態）

```bash
scripts\windows\start-office-node.cmd
```

它每 30 秒用 PowerShell `Get-CimInstance` 檢查辦公室用的 Claude Code 有沒有在跑；session 關掉時 UI 會把那個 Claude 顯示為離線。

---

## 四、開機自動啟動（Windows 工作排程器）

在專案根目錄開 PowerShell。A 機（Hub＋Windows 端 node＋WSL 的 Hermes 接線）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Hub -Node -WslHermes
```

B 機：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Node
```

工作會在登入時啟動，掛掉後每分鐘自動重啟；日誌在 `data\logs\`。移除：加 `-Uninstall`。WSL 發行版不是預設的話加 `-Distro Ubuntu`。WSL 有開 systemd 的話，也可以改用 `scripts/wsl/office-node.service`（裡面有安裝說明）。

辦公室用的 Claude Code（`office-claude.cmd`）要在終端機互動執行，不適合放進排程。

---

## 五、使用

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

## 六、API

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

## 七、安全

- Hub 只綁 Tailscale IP，不開對外 port
- 每個帳號一組 token，資料庫只存雜湊；`bun run cli token <帳號>` 可換新 token
- Claude Code 會把其他 agent 的訊息標示為「來自同事」，不是你的指令
- 權限批准只接受 `approvers` 裡的真人；其他 bot 回「yes 代碼」或按按鈕都無效（有測試）
- hooks 只送事件名稱、工具名稱和指令前 300 字，不送檔案內容與工具輸出

## 八、已知限制

- 頻道是研究預覽功能，旗標名稱和行為之後可能改變
- Hermes 本地模型能接多大的任務，取決於你的模型呼叫工具穩不穩；先從小任務開始
- `hermes chat -Q -q` 的參數依 Hermes 版本可能不同，用 `office doctor` 檢查，必要時改 `hermes.cmd` 或改用 `api` 模式
- 同一台機器同時開多個 office session 會共用同一個 Claude 帳號，請只開一個
- 目前只有一個 Hermes（A 機 WSL）；B 機的檔案工作要派給 Claude-B，或先把檔案傳到 A 機
- Hub 在家裡電腦，關機時整個系統停擺

## 九、開發與測試

```bash
bun install
(cd claude/office && bun install)
bun test
```

```bash
bun run cli list
bun run cli add codex_a --name Codex-A --kind other --machine A
```
