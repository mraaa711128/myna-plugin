// /myna:config in Claude Code's own mod test kit (`claude plugin test` from the repo root; needs the Claude Code
// CLI, so it is not in CI — test/smoke-config.mjs covers the same on a stub `$`). The test's own command.run hook
// sits beneath the chat mod and stands for the engine running commands/config.md (scripts/config.mjs):
//   - /myna:config <any item but chat> → the mod passes it on (next) with the arguments untouched
//   - /myna:config chat on|off → the chat mod answers, the same as /myna:chat; the markdown never runs
//   - /myna:chat's answer carries the hint line
//   - "!myna:config chat off" from the phone → answered by the mod, not run as a command
import { expect, mock, test } from 'claude-code/testing'

function stubs(on, takes: any[] = []) {
  const clock = mock.clock(on)
  mock.store(on, {})
  const posts: any[] = []
  const markdown: any[] = []
  on('env.get', ($, e) => ({ value: ({ HOME: '/h', MYNA_CHAT: 'on', RELAY_PORT: '7999' } as any)[e.name] }))
  on('fs.read', ($, e) => (String(e.path).endsWith('relay-secret') ? { value: 'x'.repeat(64) } : { deny: 'no such file' }))
  on('session.id', () => ({ value: 'kit-1' }))
  on('session.root', () => ({ value: '/w' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('http.fetch', ($, e) => {
    const url = String(e.url)
    posts.push({ url, body: String(e.init?.body || '') })
    if (url.endsWith('/chat/register')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ token: 't', nick: 'egret', topic: 1, queued: 0 }) } }
    if (url.endsWith('/chat/take')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ messages: takes.splice(0), queued: 0 }) } }
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.start', () => ({ cwd: '/w' }))
  // the engine's own run of the markdown command (commands/config.md)
  on('command.run', { command: 'myna:config' }, ($, e) => { markdown.push(e.args); return { text: `markdown:${e.args}` } })
  return { clock, posts, markdown }
}

test('/myna:config <not chat> goes on to the markdown command, arguments untouched', async ($, on) => {
  const s = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await s.clock.settle()
  expect((await $.command.run({ command: 'myna:config', args: 'autopilot on' })).text).toBe('markdown:autopilot on')
  expect((await $.command.run({ command: 'myna:config', args: 'hold max 6h' })).text).toBe('markdown:hold max 6h')
  expect((await $.command.run({ command: 'myna:config' })).text).toBe('markdown:')
  expect((await $.command.run({ command: 'myna:config', args: 'chatty' })).text).toBe('markdown:chatty')
  expect(s.markdown).toEqual(['autopilot on', 'hold max 6h', '', 'chatty'])
})

test('/myna:config chat on|off is the chat mod\'s, the same as /myna:chat', async ($, on) => {
  const s = stubs(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await s.clock.settle()
  const off = (await $.command.run({ command: 'myna:config', args: 'chat off' })).text
  expect(off).toContain('聊天已關閉')
  expect((await $.command.run({ command: 'myna:config', args: 'chat' })).text).toBe('💬 聊天目前關閉。用 /myna:chat on 開啟。')
  const on1 = (await $.command.run({ command: 'myna:config', args: 'chat on' })).text
  expect(on1).toContain('聊天已開啟')
  const viaChat = (await $.command.run({ command: 'myna:chat', args: 'off' })).text
  expect(viaChat).toBe(`${off}\n提示：/myna:chat 之後會移除，請改用 /myna:config chat on|off`)
  expect((await $.command.run({ command: 'myna:config', args: 'chat maybe' })).text).toContain('只接受 on 或 off')
  expect(s.markdown).toEqual([])
})

test('"!myna:config chat off" from the phone is answered by the mod, not run as a command', async ($, on) => {
  const s = stubs(on, [{ id: 'm1', text: '!myna:config chat off' }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await s.clock.settle()
  await s.clock.advance(2500)
  await s.clock.settle()
  const done = s.posts.filter((p) => p.url.endsWith('/chat/progress') && p.body.includes('"done"'))
  expect(done.length).toBe(1)
  expect(done[0].body).toContain('/myna:config chat on')
  expect(s.markdown).toEqual([])
  expect((await $.command.run({ command: 'myna:config', args: 'chat' })).text).toContain('聊天目前關閉')
})
