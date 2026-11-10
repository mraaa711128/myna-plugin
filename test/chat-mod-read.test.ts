// The chat mod's tool.check hook in Claude Code's own mod test kit (`claude plugin test` from the repo root;
// needs the Claude Code CLI, so it is not in CI — test/smoke-files.mjs covers the same on a stub `$`).
// A file the relay handed the session (file_path in /chat/take) may be Read without a prompt: Claude Code's
// "ask" becomes "allow"; another file, a subagent's Read, an Edit, or a file that is now a link stay "ask".
import { expect, mock, test } from 'claude-code/testing'

const BS = String.fromCharCode(92)
const P = ['C:', 'h', '.myna', 'inbox', 'abc', '20261110-000000-0123456789abcdef.pdf'].join(BS)
const OTHER = ['C:', 'h', '.myna', 'inbox', 'abc', 'other.pdf'].join(BS)
const stats: any[] = []

function stubs(on, takes: any[], { link = false } = {}) {
  const clock = mock.clock(on)
  mock.store(on, {})
  on('env.get', ($, e) => ({ value: ({ HOME: '/h', MYNA_CHAT: 'on', RELAY_PORT: '7999' } as any)[e.name] }))
  on('fs.read', ($, e) => (String(e.path).endsWith('relay-secret') ? { value: 'x'.repeat(64) } : { deny: 'no such file' }))
  on('session.id', () => ({ value: 'kit-1' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('settings.read', () => ({ value: {} }))
  on('fs.stat', ($, e) => { stats.push(e); return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: link, realPath: e.path } } })
  on('http.fetch', ($, e) => {
    const url = String(e.url)
    if (url.endsWith('/chat/register')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ token: 't', nick: 'egret', topic: 1, queued: 0 }) } }
    if (url.endsWith('/chat/take')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ messages: takes.splice(0), queued: 0 }) } }
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.start', () => ({ cwd: '/w' }))
  on('tool.check', ($, e) => ({ decision: 'ask' }))
  return clock
}

test('Read of a delivered file: ask -> allow; other files, subagents, Edit stay ask', async ($, on) => {
  const clock = stubs(on, [{ id: 'm1', text: 'x', file_path: P }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await clock.settle()
  await clock.advance(2500)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: P } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: P.split(BS).join('/').toUpperCase() } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: OTHER } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: P }, agentId: 'a1' })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: P } })).decision).toBe('ask')
  expect(stats[0].resolve).toBe(true)
})

test('a delivered file that is now a link stays ask', async ($, on) => {
  const clock = stubs(on, [{ id: 'm1', text: 'x', file_path: P }], { link: true })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await clock.settle()
  await clock.advance(2500)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: P } })).decision).toBe('ask')
})
