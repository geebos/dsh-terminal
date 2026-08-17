import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  PtySessionManager,
  RingBuffer,
  type PtySession,
  type SandboxLike,
  type SandboxPolicyLike,
} from '../src/pty-session.ts'
import {
  FakeHandle,
  FakeSocket,
  FakeSubprocess,
  fakeAgent,
  flush,
  stubContext,
} from './helpers.ts'

function makeManager(subprocess: FakeSubprocess): PtySessionManager {
  return new PtySessionManager(stubContext(), { subprocess }, 64 * 1024)
}

let managers: PtySessionManager[] = []

function track(manager: PtySessionManager): PtySessionManager {
  managers.push(manager)
  return manager
}

afterEach(async () => {
  for (const manager of managers) await manager.disposeAll()
  managers = []
})

describe('RingBuffer', () => {
  it('keeps write order across a wrap-around', () => {
    const ring = new RingBuffer(8)
    ring.write(Buffer.from('12345'))
    ring.write(Buffer.from('6789'))
    expect(ring.snapshot().toString()).toBe('23456789')
    expect(ring.size).toBe(8)
  })

  it('drops the oldest bytes when a single chunk exceeds capacity', () => {
    const ring = new RingBuffer(4)
    ring.write(Buffer.from('abcdefgh'))
    expect(ring.snapshot().toString()).toBe('efgh')
  })

  it('handles exact-capacity and empty writes', () => {
    const ring = new RingBuffer(4)
    ring.write(Buffer.from('abcd'))
    expect(ring.snapshot().toString()).toBe('abcd')
    ring.write(Buffer.alloc(0))
    expect(ring.snapshot().toString()).toBe('abcd')
  })

  it('rejects non-positive capacities', () => {
    expect(() => new RingBuffer(0)).toThrow()
  })
})

describe('PtySessionManager', () => {
  it('spawns a TERM-wrapped interactive shell in the session cwd', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const spec = subprocess.specs[0] as { argv: string[]; cwd: string; rows: number; cols: number; env: Record<string, string> }

    expect(spec.argv[0]).toBe('/bin/sh')
    expect(spec.argv[1]).toBe('-c')
    expect(spec.argv[2]).toMatch(/TERM=xterm-256color/)
    expect(spec.argv[2]).toMatch(/exec ".*" -i$/)
    expect(spec.cwd).toBe('/tmp/proj')
    expect(spec.rows).toBe(24)
    expect(spec.cols).toBe(100)
    expect(typeof spec.env.DSH_TERM_SHELL).toBe('string')
    expect(session.status).toBe('alive')
    expect(manager.list('sess-1').map(item => item.name)).toEqual(['tab1'])
    expect(manager.get('sess-1', session.tabId)?.info()).toMatchObject({ name: 'tab1', status: 'alive' })
  })

  it('broadcasts output to the attached socket and records it in the ring', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const socket = new FakeSocket()
    expect(manager.attach('sess-1', session.tabId, socket, true))
      .toMatchObject({ ok: true })

    ;(subprocess.handles[0] as FakeHandle).output.write('hello ')
    ;(subprocess.handles[0] as FakeHandle).output.write('world')
    await flush()

    expect(socket.byteStream().toString()).toBe('hello world')
    expect(session.ring.snapshot().toString()).toBe('hello world')
  })

  it('delivers pre-attach output as live bytes and replays the ring on re-attach', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    // Written while no observer exists: parked in the stream buffer, then
    // delivered live once the attach resumes the pump.
    ;(subprocess.handles[0] as FakeHandle).output.write('prompt\r\n')

    const first = new FakeSocket()
    const result = manager.attach('sess-1', session.tabId, first, true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.replayBytes.length).toBe(0)
    await flush()
    expect(first.byteStream().toString()).toBe('prompt\r\n')

    manager.detach(first)
    const second = new FakeSocket()
    const replay = manager.attach('sess-1', session.tabId, second, true)
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.replayBytes.toString()).toBe('prompt\r\n')
  })

  it('rejects duplicate observers until the previous one detaches', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const first = new FakeSocket()
    expect(manager.attach('sess-1', session.tabId, first, true)).toMatchObject({ ok: true })

    const second = new FakeSocket()
    expect(manager.attach('sess-1', session.tabId, second, true))
      .toMatchObject({ ok: false, code: 'TAB_ALREADY_ATTACHED' })

    manager.detach(first)
    expect(manager.attach('sess-1', session.tabId, second, false)).toMatchObject({ ok: true })
  })

  it('reports unknown keys with distinct error codes', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    await manager.spawn(agent, 'tab1')
    expect(manager.attach('sess-1', 'missing-tab', new FakeSocket(), true))
      .toMatchObject({ ok: false, code: 'TAB_NOT_FOUND' })
    expect(manager.attach('other-session', 'missing-tab', new FakeSocket(), true))
      .toMatchObject({ ok: false, code: 'SESSION_NOT_FOUND' })
  })

  it('keeps the tab after exit with the exit code and notifies observers', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const socket = new FakeSocket()
    manager.attach('sess-1', session.tabId, socket, false)

    ;(subprocess.handles[0] as FakeHandle).doneResolvers.resolve({ exitCode: 3 })
    await flush()

    expect(session.status).toBe('exited')
    expect(session.exitCode).toBe(3)
    expect(socket.controlFrames()).toContainEqual({ type: 'exit', exitCode: 3 })
    expect(manager.list('sess-1')).toHaveLength(1)
    manager.feed('sess-1', session.tabId, 'ignored')
    expect((subprocess.handles[0] as FakeHandle).writes).toEqual([])
    await expect(manager.signal('sess-1', session.tabId, 'SIGINT')).resolves.toBe(false)
  })

  it('routes stdin and explicit signals to the live handle', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    manager.feed('sess-1', session.tabId, 'ls\r')
    await expect(manager.signal('sess-1', session.tabId, 'SIGTERM')).resolves.toBe(true)
    const handle = subprocess.handles[0] as FakeHandle
    expect(handle.writes).toEqual(['ls\r'])
    expect(handle.signals).toEqual(['SIGTERM'])
  })

  it('kill terminates the tree, closes observers, and drops the tab', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const socket = new FakeSocket()
    manager.attach('sess-1', session.tabId, socket, false)

    await expect(manager.kill('sess-1', session.tabId)).resolves.toBe(true)
    expect((subprocess.handles[0] as FakeHandle).terminated).toBe(1)
    expect(socket.closedWith).toBe(1000)
    expect(manager.list('sess-1')).toHaveLength(0)
    await expect(manager.kill('sess-1', session.tabId)).resolves.toBe(false)
  })

  it('owner cleanup kills every tab of that dsh session only', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const ownerA = fakeAgent('sess-1')
    const ownerB = fakeAgent('sess-2')
    await manager.spawn(ownerA.agent, 'tab1')
    await manager.spawn(ownerA.agent, 'tab2')
    await manager.spawn(ownerB.agent, 'tab1')

    ownerA.cleanup()
    await flush()

    expect(manager.list('sess-1')).toHaveLength(0)
    expect(manager.list('sess-2')).toHaveLength(1)
    expect((subprocess.handles[2] as FakeHandle).terminated).toBe(0)
  })

  it('pauses the output pump under backpressure and resumes after drain', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const handle = subprocess.handles[0] as FakeHandle
    const pause = vi.spyOn(handle.output, 'pause')
    const resume = vi.spyOn(handle.output, 'resume')

    const socket = new FakeSocket()
    manager.attach('sess-1', session.tabId, socket, false)
    await flush()
    expect(resume).toHaveBeenCalled()

    socket.bufferedAmount = 2 * 1024 * 1024
    handle.output.write('flood')
    await flush()
    expect(pause).toHaveBeenCalled()

    socket.bufferedAmount = 0
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(resume.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('drops a consumer beyond the hard cap instead of buffering forever', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session = await manager.spawn(agent, 'tab1')
    const socket = new FakeSocket()
    socket.bufferedAmount = 0
    manager.attach('sess-1', session.tabId, socket, false)

    socket.bufferedAmount = 16 * 1024 * 1024
    ;(subprocess.handles[0] as FakeHandle).output.write('chunk')
    await flush()

    expect(socket.terminated).toBe(true)
    expect(session.attached.size).toBe(0)
  })

  it('refuses to spawn without a subprocess service', async () => {
    const manager = track(new PtySessionManager(stubContext(), {}, 64 * 1024))
    const { agent } = fakeAgent()
    await expect(manager.spawn(agent, 'tab1')).rejects.toThrow('subprocess')
    expect(manager.unavailableReason()).toContain('subprocess')
  })

  it('spawns unsandboxed by default and confines only with DSH_TERMINAL_SANDBOX=1', async () => {
    const subprocess = new FakeSubprocess()
    const sandbox: SandboxLike = {
      confine: (argv: readonly string[]) => ({ argv: ['confined', ...argv] }),
    }
    const sandboxPolicy: SandboxPolicyLike = { resolve: () => ({ mode: 'read-only' }) }
    const manager = track(new PtySessionManager(stubContext(), { subprocess, sandbox, sandboxPolicy }, 64 * 1024))
    const { agent } = fakeAgent()

    await manager.spawn(agent, 'tab1')
    expect((subprocess.specs[0] as { argv: string[] }).argv[0]).toBe('/bin/sh')

    process.env.DSH_TERMINAL_SANDBOX = '1'
    try {
      await manager.spawn(agent, 'tab2')
      expect((subprocess.specs[1] as { argv: string[] }).argv[0]).toBe('confined')

      const fullAccess: SandboxPolicyLike = { resolve: () => ({ mode: 'danger-full-access' }) }
      const looseManager = new PtySessionManager(stubContext(), { subprocess, sandbox, sandboxPolicy: fullAccess }, 64 * 1024)
      track(looseManager)
      await looseManager.spawn(agent, 'tab3')
      expect((subprocess.specs[2] as { argv: string[] }).argv[0]).toBe('/bin/sh')
    } finally {
      delete process.env.DSH_TERMINAL_SANDBOX
    }
  })
})

describe('PtySession info snapshot', () => {
  it('projects the wire shape', async () => {
    const subprocess = new FakeSubprocess()
    const manager = track(makeManager(subprocess))
    const { agent } = fakeAgent()
    const session: PtySession = await manager.spawn(agent, 'tab7')
    expect(session.info()).toMatchObject({ name: 'tab7', status: 'alive', exitCode: null })
    expect(typeof session.info().createdAt).toBe('number')
  })
})
