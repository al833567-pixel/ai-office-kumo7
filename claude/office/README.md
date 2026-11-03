# office（AI 辦公室頻道外掛）

把這個 Claude Code session 接到自架的 Office Hub。Hub 上的派工、回報、聊天會推進 session（Claude Code channels），Claude 用 `reply` 回覆；session 的狀態（工具呼叫、等待批准、出錯）透過 hooks 回報給 Hub，顯示在像素辦公室 UI。

改寫自官方 Telegram 頻道外掛（Apache-2.0，見 NOTICE）：改成連 Hub 而不是 api.telegram.org，加上討論串與任務資料，權限批准只接受真人。

只有用 `office-claude` 啟動（環境變數 `OFFICE_SESSION=1`）的 session 會啟用；平常開的 Claude Code 不受影響。

設定由 `office setup-claude` 寫入 `~/.claude/channels/office/`（`.env`、`access.json`）。完整安裝步驟見 Office Hub 根目錄的 README。
