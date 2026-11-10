// The chat mod's tool.check hook in Claude Code's own mod test kit (`claude plugin test` from the repo root;
// needs the Claude Code CLI, so it is not in CI — test/smoke-files.mjs covers the same on a stub `$`).
// A file the relay handed the session (file_path in /chat/take) may be Read without a prompt: Claude Code's
// "ask" becomes "allow"; another file, a subagent's Read, an Edit, or a file that is now a link stay "ask".
import { expect, mock, test } from 'claude-code/testing'

const BS = String.fromCharCode(92)
const P = ['C:', 'h', '.myna', 'inbox', 'abc', '20261110-000000-0123456789abcdef.pdf'].join(BS)
const OTHER = ['C:', 'h', '.myna', 'inbox', 'abc', 'other.pdf'].join(BS)
const stats: any[] = []

// like the engine on Windows: realPath is the file's own spelling; `other` = a case variant that is another file
function stubs(on, takes: any[], { link = false, noReal = false, other = false, parentLink = false, statThrows = false } = {}) {
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
  on('fs.stat', ($, e) => {
    stats.push(e)
    if (statThrows) return { deny: 'stat refused' }
    const p = String(e.path)
    const same = p.toLowerCase() === P.toLowerCase()
    if (!same && P.toLowerCase().startsWith(p.toLowerCase())) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: parentLink && p.toLowerCase() === P.toLowerCase().slice(0, P.lastIndexOf(BS)) } }
    const realPath = same && !other ? P : p
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: link, ...(noReal ? {} : { realPath }) } }
  })
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

async function delivered($, on, opts = {}) {
  const clock = stubs(on, [{ id: 'm1', text: 'x', file_path: P }], opts)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await clock.settle()
  await clock.advance(2500)
}
const read = ($, file_path) => $.tool.check({ tool: 'Read', input: { file_path } }).then((d) => d.decision)

test('a case variant that is another file (a case-sensitive folder) stays ask', async ($, on) => {
  await delivered($, on, { other: true })
  expect(await read($, P.toUpperCase())).toBe('ask')
})

test('an older CLI without realPath: only the exact path, with plain folders above it', async ($, on) => {
  await delivered($, on, { noReal: true })
  expect(await read($, P)).toBe('allow')
  expect(await read($, P.toUpperCase())).toBe('ask')
})

test('an older CLI: a folder above that is a link stays ask', async ($, on) => {
  await delivered($, on, { noReal: true, parentLink: true })
  expect(await read($, P)).toBe('ask')
})

test('stat refused stays ask', async ($, on) => {
  await delivered($, on, { statThrows: true })
  expect(await read($, P)).toBe('ask')
})

test('a delivered file that is now a link stays ask', async ($, on) => {
  const clock = stubs(on, [{ id: 'm1', text: 'x', file_path: P }], { link: true })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await clock.settle()
  await clock.advance(2500)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: P } })).decision).toBe('ask')
})
