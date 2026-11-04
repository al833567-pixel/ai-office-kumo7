# AI 辦公室（Office Hub）

![AI 辦公室畫面：主管在會議室等回報，Hermes 和另一個 Claude 在座位上工作，Codex 在任務看板前排隊，小黑在會議桌上](docs/images/office.png)

<sub>示範畫面：主管「小克」在會議室等回報，赫米（Hermes）和小B（Claude）在座位上工作，Codex 排隊等前面的任務完成，Antigravity 在休息區，小黑跑到會議桌上。</sub>

讓兩台 Windows 電腦上的 Claude Code 和 Hermes 組成一個團隊：你在任一台的 Claude Code 輸入 `/office 目標`，那台的 Claude 就當主管，拆任務派給其他人。進度、回報、檔案都經過家裡電腦上的 Hub，像素辦公室 UI 即時顯示每個人在做什麼。

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
│ Hermes（hermes.exe，hermes_a）           │   │ （claude_b）＋ office-node   │
│ office-node（claude_a + hermes_a）       │   └──────────────────────────────┘
└──────────────────────────────────────────┘
```

| 資料夾 | 內容 |
|---|---|
| `src/` | Hub 伺服器 |
| `ui/index.html` | 像素辦公室 UI（Hub 首頁） |
| `claude/` | Claude Code 本機 marketplace：`office` 頻道外掛（改寫自官方 Telegram 外掛）＋ `/office` skill |
| `node/` | 每台 agent 機器用的 `office` 指令（Hermes 接線、檔案上傳下載、設定 Claude） |
| `scripts/windows/`、`scripts/linux/` | 啟動腳本與開機常駐：Windows 工作排程器、Linux／WSL systemd |
| `docs/平台相容.md` | 各平台（Claude、Hermes、Codex、Antigravity）當櫃台／主管／執行者的接法與 Windows／Linux 對照 |
| `test/` | 56 項測試（含真正的 grammY、官方 MCP SDK、外掛端對端、假 Hermes 全流程），Windows 與 Linux 都能跑 |

## 需求

實際環境：兩台 Windows；家裡電腦（A 機）跑 Hub 和 Hermes（Windows 原生版）。

- 兩台 Windows：[Bun](https://bun.sh)（`winget install Oven-sh.Bun`）、Git、Claude Code 命令列版（`winget install Anthropic.ClaudeCode`；用 claude.ai 帳號登入，頻道功能需要）
  - 只裝了 Claude 桌面版的話，PATH 裡沒有 `claude` 指令，`office-claude.cmd` 會找不到；請另外用 winget 安裝命令列版。`office doctor` 會檢查這一項。
- A 機：Hermes Agent（Windows 原生版，測過 v0.22.5）
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
| `hermes_a` | Hermes | A 機 Windows |

舊版 `init` 會多建一個 `hermes_b`，用不到就停用：`bun run cli disable hermes_b`。

啟動 Hub：

```bash
scripts\windows\start-hub.cmd
```

預設只聽 `127.0.0.1:7070`。在 A 機用瀏覽器開 `http://127.0.0.1:7070/`：第一次會請你**設定管理者帳號和密碼**，之後在任何電腦都用這組帳密登入，不用 token。（第一次設定只能在 A 機本機做，避免別台搶先設定；忘記密碼時仍可點「改用 token 登入」，用 `data\tokens.local.json` 裡 `boss` 的 token 登入後再改密碼。）

要讓 B 機連進來時：登入 Tailscale，在專案根目錄建立 `hub.env.cmd`，寫一行 `set HUB_HOST=127.0.0.1,<A 機的 Tailscale IP>`（用 `tailscale ip -4` 查），重開 Hub。本機與 Tailscale 同時可連，A 機現有的設定都不用改；B 機用 Tailscale IP 連。

### Hub 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `HUB_HOST` | `127.0.0.1` | 綁定位址，可用逗號列多個（例如 `127.0.0.1,100.x.y.z`）。對外請用 Tailscale IP，不要用 `0.0.0.0` |
| `HUB_PORT` | `7070` | 連接埠 |
| `HUB_DB` | `data/office.db` | 資料庫；檔案存在旁邊的 `files/` |
| `HUB_LEASE_MIN` | `15` | 任務租約分鐘數，超過沒回報進度就退回待辦 |
| `HUB_STALL_MIN` | `5` | 做任務時超過幾分鐘沒動靜算「卡住」 |
| `HUB_OFFLINE_SEC` | `120` | 超過幾秒沒連線算「離線」 |
| `HUB_LOOP_LIMIT` | `30` | 同一串對話 bot 之間來回幾次就暫停，等你發言 |
| `HUB_LOG` | `1` | 設 `0` 關閉請求紀錄 |

---

## 二、A 機：接上 Hermes（Windows 原生版）

A 機的 Hermes 是 Windows 原生版（`%LOCALAPPDATA%\hermes\bin\hermes.exe`），office-node 直接在 Windows 上呼叫它，不需要 WSL。同一個 office-node 同時負責 `claude_a`（回報 session 狀態）與 `hermes_a`（心跳、接派工）。

### 1. 設定檔

複製 `node\config.windows-A.example.json` 到 `%USERPROFILE%\.office\config.json`，填入 `claude_token`（`claude_a`）與執行者 `hermes_a` 的 `token`。執行者寫在 `workers` 陣列裡，範例已經寫好：

```json
"workers": [
  {
    "name": "hermes_a",
    "token": "<hermes_a 的 token>",
    "cmd": ["%LOCALAPPDATA%\\hermes\\bin\\hermes.exe", "chat", "-Q", "--query-file", "{prompt_file}"],
    "cwd": "~/office-work",
    "timeout_min": 30
  }
]
```

舊版寫法（`hermes_token` 加 `hermes` 區塊）仍然有效，不必改。之後要在同一台加 Codex、Antigravity 等其他執行者，就在 `workers` 多加一段，見 [docs/平台相容.md](docs/平台相容.md)。

- **用絕對路徑**：工作排程器啟動時的 PATH 可能和你的終端機不同，寫完整路徑最穩。`%LOCALAPPDATA%`、`~` 會自動展開，不必寫死使用者名稱。
- **`--query-file {prompt_file}`**：office-node 把提示詞寫成暫存檔，`{prompt_file}` 換成它的路徑。這樣可以避開 Windows 命令列的長度上限，也不會被換行或引號弄壞。
- **`--oneshot` 先不用加**：`-Q --query-file` 本來就是執行一次就結束。如果實測發現 Hermes 執行完沒有結束（等待輸入或停在互動畫面），再把 `"--oneshot"` 加在 `"chat"` 後面。
- 呼叫 Hermes 時會自動設定 `PYTHONUTF8=1`，避免中文輸出變亂碼。
- 想改用 Hermes API server（`hermes gateway` 開的 `:8642`）的話：`"mode": "api"`，再填 `api_url`、`api_key`。

### 2. 檢查與啟動

```bash
bun node/office.ts doctor
```

```bash
bun node/office.ts run
```

`run` 會：
- 送 Hermes 心跳，UI 上 Hermes 才會顯示在線。
- 檢查辦公室用的 Claude session 有沒有在跑。
- 收到 `@hermes_a` 的派工時：領取任務 → 執行 Hermes → 跑驗收指令 → 上傳 `OFFICE_OUT` 裡的檔案 → 回報。執行中每 30 秒更新進度並延長租約。
- 真人在群組 @ 它聊天時，它會用 Hermes 回答。

常駐的方式見第四節。

**回報只交答案**：Hermes 會被要求把給主管的結論寫進任務資料夾的 `answer.md`（沒寫的話取輸出的最後一段），回報內容就是這個結論加上驗收結果，過程不送出。完整過程存成同一個資料夾的 `hermes-<時間>.log`；Hermes 的 `session_id` 和這個檔案的位置會記在任務上，在 UI 的任務卡片可以複製，方便日後查。

**任務的工作目錄**是 `~/office-work/task-<編號>`，交付檔案放在裡面的 `out` 資料夾。驗收指令由 `cmd.exe` 在這個目錄裡執行，所以要寫 Windows 指令，例如：

```bat
powershell -NoProfile -Command "if ((Get-Item out\report.csv).Length -gt 0) { exit 0 } else { exit 1 }"
```

> 改在 WSL 或 Linux 跑 Hermes 的話：用 `node/config.linux.example.json`、`scripts/linux/start-office-node.sh`。WSL 要在 `%USERPROFILE%\.wslconfig` 設定 `networkingMode=mirrored`，才連得到 Windows 上的 `127.0.0.1:7070`。

---

## 加入新的 agent（不用手動貼 token）

在新的電腦（或同一台要多加一個 AI）執行一行，網頁上按確認就好：

```bash
office join http://<A 機的 Tailscale IP>:7070 --kind claude --machine B
```

1. 那台的終端機會印出 4 位數**確認代碼**；辦公室網頁上方同時跳出申請卡片。
2. 核對兩邊代碼一樣，可以改名稱或帳號，按「確認加入」。
3. token 自動寫進那台的 `~/.office/config.json`（原本的設定會保留）：
   - `--kind claude`：寫成 `claude_token`，並自動執行 `office setup-desktop`（Claude Code 桌面版當主管）。要用終端機頻道模式就加 `--channel`。
   - `--kind hermes|codex|antigravity`：加進 `workers`，並填好該平台的預設執行指令；`other` 要自己填指令。
4. 重新啟動 office-node（`office run` 或「AI Office Node」排程工作）。

說明：
- 種類：`claude`、`hermes`、`codex`、`antigravity`、`other`；`--name` 可指定顯示名稱；`--machine` 不填就用設定檔裡的 `machine`，再沒有就用電腦名稱。
- 卡片上的帳號預設是「種類_機器」（例如 `claude_b`）。這個帳號已經存在且種類相同（例如 `init` 建好的 `claude_b`）就是**重新加入**：沿用帳號、換新 token，舊 token 立即失效。重灌或換電腦時也這樣用。
- 申請 15 分鐘內有效，被拒絕或過期時那台不會改設定檔。
- 原本手動貼 token 的方式（`bun run cli add`、設定檔）仍然可以用。

### 管理已加入的成員

網頁右上角「成員」：列出所有 agent 的狀態、最後連線時間、手上的任務，可以：
- **改名稱、機器代號、種類**，按「儲存」。
- **停用**：token 立即失效、從辦公室畫面拿掉，之後可以「重新啟用」（用原本的 token，不必重新設定）。
- **刪除**：帳號和 token 永久作廢，帳號名稱空出來（例如重新 `office join` 會再建一個新的 `hermes_c`）；聊天和任務紀錄保留原本的名字。

停用或刪除時，它手上未完成的任務會自動改派給各目標的主管；如果它自己就是某個目標的主管，網頁會提示你到看板處理。真人帳號只列出、不能在這裡停用。

---

## 三、兩台 Windows：設定 Claude Code

以下 A、B 兩台各做一次（B 機先 `git clone` 專案、`bun install`）。

### 1. 設定檔

A 機在第二節已經建好設定檔。B 機最簡單的做法是 `office join http://<A 機的 Tailscale IP>:7070 --kind claude --machine B`，在網頁按確認（見上一節）；或手動複製 `node\config.windows-B.example.json` 到 `%USERPROFILE%\.office\config.json`，填 `claude_b` 的 token，`hub` 填 A 機的 Tailscale IP。

把 `node` 資料夾加進使用者 PATH（讓 Claude 能在終端機執行 `office upload`、`office download`）：

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";D:\AI home\ai-office-kumo7\node", "User")
```

重開終端機後檢查：

```bash
office doctor
```

### 2. 寫入 Claude 設定、安裝外掛

```bash
office setup-claude
```

它會寫入 `%USERPROFILE%\.claude\channels\office\.env`、`access.json`（允許其他 agent 與你傳訊息，只有 `approvers` 能批准權限），並安裝 `/office` skill。接著照它印出的兩行指令做（只需一次）：

```bash
claude plugin marketplace add "D:\AI home\ai-office-kumo7\claude"
```

```bash
claude plugin install office@office-local
```

`office_*` 工具（開目標、派工、回報、等待…）由 office 外掛直接提供，用的是這個 session 自己的帳號，不需要再 `claude mcp add`。之前加過 `office-hub` 的話可以移除，避免工具重複：

```bash
claude mcp remove office-hub -s user
```

同一台要開第二個以上的 Claude：見 [docs/平台相容.md](docs/平台相容.md) 第四節（`office setup-claude --as <帳號>`、`office-claude <帳號>`）。

### 3. 啟動辦公室用的 Claude Code

```bash
node\office-claude.cmd
```

這等於設定 `OFFICE_SESSION=1` 後執行 `claude --dangerously-load-development-channels plugin:office@office-local`，所以 PATH 裡要有命令列版的 `claude`（見「需求」）。第一次啟動會先要你選主題、登入 claude.ai。第一次會出現開發者頻道的確認畫面，選「I am using this for local development」。

只有這個 session 會連 Hub；你平常開的 `claude` 不受影響。這個視窗要一直開著（頻道只在 session 開著時收得到訊息）。

為了不被權限提示卡住，建議先把常用指令加進允許清單，或用 auto 模式。卡住時 UI 會顯示「等你批准」，你也可以直接在 UI 的「私訊／批准」按允許。

### 4. office-node（回報 Claude session 狀態）

```bash
scripts\windows\start-office-node.cmd
```

它每 30 秒用 PowerShell `Get-CimInstance` 檢查辦公室用的 Claude Code 有沒有在跑；session 關掉時 UI 會把那個 Claude 顯示為離線。A 機的這個程式同時也是 Hermes 接線（第二節的 `run` 就是它），不用另外再開一個。

### 改用 Claude Code 桌面版當主管（不用開終端機）

只想在桌面版打字派工的話，第 2、3 步改成下面這樣（兩種擇一，同一個帳號不要兩邊同時開）：

```bash
office setup-desktop
```

它會把 Hub 的 MCP（`office-desktop`，用 `claude_token` 的帳號）加進 Claude Code 設定、移除舊的重複設定 `office-hub`，並安裝 `/office` skill。桌面版和命令列讀同一份設定，所以 PATH 裡要有命令列版 `claude`；沒有的話它會印出手動指令。接著：

1. 設定檔 `~/.office/config.json` 加上 `"claude_mode": "desktop"`，重開 office-node。桌面版沒有 hooks，改由 office-node 在跑就把這個 Claude 顯示為在線。
2. 重開桌面版，開一個本機 session，輸入 `/office <目標>`。

office 外掛（`office@office-local`）在桌面版用不到：沒有 `OFFICE_SESSION=1` 時它不提供工具，hooks 也不動作，留著無害。確定不再用終端機模式的話可以移除：

```bash
claude plugin uninstall office@office-local
```

桌面版會自己開目標、派工，然後在同一輪裡用 `office_wait` 等回報、審查、結案，最後在對話裡交出成果。差別是：桌面版不能被「叫醒」，所以**等待期間那一輪會一直跑**，你要在它等的時候插話，按停止再打字即可（之後說「繼續等 #目標」就會接著等）。別人（另一台 Claude、失敗改派）丟給它的工作，也要等它下一次 `office_wait` 才會看到。

---

## 四、開機自動啟動

在專案根目錄開 PowerShell。A 機（Hub＋office-node，office-node 同時負責 Claude 狀態與 Hermes）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Hub -Node
```

B 機：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Node
```

登入時會各開一個命令列視窗執行（標題「AI Office Hub」「AI Office Node」），**關掉視窗就停止**，不會自動重開；日誌在 `data\logs\`。重複執行沒關係：工作已存在就更新設定，並先結束這個專案舊的 bun 再啟動。

選用參數：`-Watchdog`（每 5 分鐘檢查，沒在跑就重開；異常結束每分鐘重試）、`-Firewall`（系統管理員：只允許 Tailscale 網段 100.64.0.0/10 連 7070，已存在就略過）。移除用 `-Uninstall`。之前用系統管理員註冊過的，重新註冊也要用系統管理員。（Hermes 改在 WSL 跑的話才需要 `-WslHermes`。）

辦公室用的 Claude Code（`office-claude.cmd`）要在終端機互動執行，不適合放進排程。

**Linux（含 WSL）**用 systemd 使用者服務：Hub 那台 `bash scripts/linux/install-services.sh --hub --node`，其他機器 `--node`，移除用 `--uninstall`。WSL 要先在 `/etc/wsl.conf` 開啟 `[boot] systemd=true`。

---

## 五、使用

### 交給團隊（三種櫃台，任選）

在任一台的 office Claude Code 輸入：

```
/office 把 B 機的 nginx log 每天壓縮備份，並寫一個查詢 404 的小工具
```

這台的 Claude 會當主管：開目標 → 看誰空閒 → 拆任務派工（Hermes 拿單一可驗證的工作，程式交給 Claude）→ 收回報、審查 → 下載檔案 → 在這個 session 跟你報告。另一個 Claude 在線時自動當審查者；不在線就不指定，由主管自己審。

也可以在 UI 上方輸入目標，選主管（自動／Claude-A／Claude-B）。

或在任何終端機（Windows、Linux 都可以）用 `office ask`，等到結案後印出總結，需要設定檔裡的 `boss_token`：

```bash
office ask "整理兩台電腦的磁碟使用量，做成表格" --download ./結果
```

Hermes、Codex、Antigravity 等支援 MCP 的平台也能當櫃台（接 Hub 的 `/mcp`，用 `office_new_goal` 加 `office_wait`），見 [docs/平台相容.md](docs/平台相容.md)。自動規則：目標提到哪台機器就給那台的 Claude → 誰空閒 → 手上工作最少。

### UI

- **辦公室**：最多 8 個工位，依帳號自動分配（一台 8 個或 8 台各 1 個都可以），不同平台有不同造型；角色依狀態走到不同地方；空閒的人每隔 20～45 秒會隨機換個休閒地點（茶水間、娛樂室、沙發、書架、窗邊、摸貓…），忙碌中的人留在原地。點角色看動態（hooks、訊息、任務）
- **名稱與圖示**：每個 agent 頭上與桌上的名牌是「公司標誌＋自訂名稱」：Claude（Anthropic 橘色放射星）、Codex（OpenAI 螺旋花瓣）、Hermes（Nous Research 標誌，綠色底）、Antigravity（Google 漸層拱形）、其他平台小機器人。圖示來源與授權見 `ui/icons/NOTICE.md`；想換成自己的圖（例如 Hermes 桌面版的圖示），把檔案放在 `data/icons/<種類>.png`。點角色後在詳情面板改名，或用 `bun run cli rename <帳號> <名稱>`，最多 24 字
- **小黑**：辦公室的黑色小狗，會亂逛、找人撒嬌、坐下，想睡覺時走回休息區左下角的狗窩睡，偶爾冒出表情；點牠會有反應
- **全螢幕**：辦公室畫面下方的「⛶ 全螢幕」或按 `F`，只放大辦公室畫面（不含看板與聊天）；`Esc` 或「✕ 離開全螢幕」離開
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
| `getJoinRequests` / `approveJoin` / `rejectJoin` | — | 真人：查看、確認、拒絕 agent 加入申請 |
| `changePassword` | — | 真人改網頁登入密碼 |
| `getMembers` / `updateMember` / `disableMember` / `enableMember` / `deleteMember` | — | 真人：成員管理（停用與刪除會把未完成任務改派給主管） |

不需要 token 的入口：`GET /auth/status`、`POST /auth/setup`（第一次設定帳密，只限 Hub 本機）、`POST /auth/login`、`POST /auth/logout`；`POST /join`（申請加入，回傳確認代碼）、`POST /join/wait`（等網頁確認後取得 token，只交一次）。
| — | `office_send`、`office_whoami`、`office_file_info` | 發訊息、身分、檔案資訊 |

---

## 七、安全

- Hub 只綁 Tailscale IP，不開對外 port
- 每個帳號一組 token，資料庫只存雜湊；`bun run cli token <帳號>` 可換新 token
- 網頁用帳號密碼登入：密碼用 argon2 雜湊；登入後拿到 90 天的 session（登出即失效）；同一個來源 10 分鐘內失敗 10 次就暫停登入；第一次設定帳密只限 Hub 本機
- agent 加入要真人在網頁確認，並核對兩邊的 4 位數代碼；token 只交給發出申請的那台（要帶申請時拿到的祕密），交出後就從資料庫清掉
- Claude Code 會把其他 agent 的訊息標示為「來自同事」，不是你的指令
- 權限批准只接受 `approvers` 裡的真人；其他 bot 回「yes 代碼」或按按鈕都無效（有測試）
- hooks 只送事件名稱、工具名稱和指令前 300 字，不送檔案內容與工具輸出

## 八、已知限制

- 頻道是研究預覽功能，旗標名稱和行為之後可能改變
- Hermes 本地模型能接多大的任務，取決於你的模型呼叫工具穩不穩；先從小任務開始
- `hermes chat -Q -q` 的參數依 Hermes 版本可能不同，用 `office doctor` 檢查，必要時改 `hermes.cmd` 或改用 `api` 模式
- 同一台機器同時開多個 office session 會共用同一個 Claude 帳號，請只開一個
- 目前只有一個 Hermes（A 機 Windows）；B 機的檔案工作要派給 Claude-B，或先把檔案傳到 A 機
- 辦公室畫面最多 8 個工位；第 9 個以後的帳號仍能派工、聊天，只是不出現在畫面上
- Codex、Antigravity 的接法已預留但未實測
- 桌面版 Hermes.exe 與 CLI 共用同一份 Hermes 設定；office-node 每個任務各執行一次 CLI，不會動到桌面版的對話
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
