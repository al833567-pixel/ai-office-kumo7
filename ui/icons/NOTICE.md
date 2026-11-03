# 平台圖示來源

| 檔案 | 標誌 | 來源 |
|---|---|---|
| `claude.svg` | Claude（Anthropic） | [LobeHub Icons](https://github.com/lobehub/lobe-icons) `claude-color` |
| `codex.svg` | OpenAI | LobeHub Icons `openai` |
| `hermes.svg` | Hermes Agent（Nous Research），白色標誌放在綠色底上 | LobeHub Icons `hermesagent` |
| `antigravity.svg` | Google Antigravity | LobeHub Icons `antigravity-color` |
| `other.svg` | 其他平台（自己畫的小機器人） | 本專案 |

LobeHub Icons 整套以 MIT 授權釋出；各標誌的商標權屬於各公司，這裡只在自己的辦公室畫面上用來辨識平台。

## 換成自己的圖示

把圖檔放在 `data/icons/<種類>.png`（或 `.svg`），例如 `data/icons/hermes.png`，Hub 會優先使用它（`data/` 不在 git 裡，`git pull` 不會蓋掉）。種類：`claude`、`hermes`、`codex`、`antigravity`、`other`。建議正方形、至少 64×64。
