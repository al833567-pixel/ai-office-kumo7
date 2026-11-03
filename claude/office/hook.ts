#!/usr/bin/env bun
// Claude Code hook → Office Hub /hooks。只在 office session（OFFICE_SESSION=1）回報；
// 任何錯誤都安靜結束、不輸出，絕不影響 Claude Code 本身。
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

if (process.env.OFFICE_SESSION !== '1') process.exit(0)
try {
  const stateDir = process.env.OFFICE_STATE_DIR
    ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'office')
  const env: Record<string, string> = {}
  for (const line of readFileSync(join(stateDir, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  const hub = (process.env.OFFICE_HUB_URL ?? env.OFFICE_HUB_URL ?? '').replace(/\/+$/, '')
  const token = process.env.OFFICE_BOT_TOKEN ?? env.OFFICE_BOT_TOKEN
  if (!hub || !token) process.exit(0)
  const raw = await Bun.stdin.text()
  const body = JSON.parse(raw || '{}')
  // 只送需要的欄位，避免把整段工具輸出傳出去
  const slim = {
    hook_event_name: body.hook_event_name,
    session_id: body.session_id,
    tool_name: body.tool_name,
    tool_input: body.tool_input ? Object.fromEntries(Object.entries(body.tool_input).filter(([k]) =>
      ['command', 'file_path', 'path', 'pattern', 'url', 'description'].includes(k)).map(([k, v]) => [k, String(v).slice(0, 300)])) : undefined,
    notification_type: body.notification_type,
    message: typeof body.message === 'string' ? body.message.slice(0, 300) : undefined,
    error: body.error ? String(body.error).slice(0, 300) : undefined,
    last_assistant_message: typeof body.last_assistant_message === 'string' ? body.last_assistant_message.slice(0, 300) : undefined,
  }
  await fetch(`${hub}/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(slim),
    signal: AbortSignal.timeout(2000),
  })
} catch {}
process.exit(0)
