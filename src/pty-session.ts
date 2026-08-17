/**
 * Host-side PTY session registry: spawns interactive shells through the
 * harness `subprocess` service, keeps a bounded byte ring of recent output for
 * reconnect replay, broadcasts live bytes to attached sockets, and ties every
 * session's lifetime to its owning dsh session (plus the host process).
 *
 * Structural service views follow the plugin's lazy `ctx.get()` convention so
 * the plugin still loads in compositions without these services.
 */

import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { TerminalSignal, TerminalTabInfo } from './types.ts'
import { encodeFrame } from './protocol.ts'

/** Fixed PTY geometry (D1: the upstream handle has no resize API). */
export const DEFAULT_COLS = 100
export const DEFAULT_ROWS = 24
/** TERM→KILL grace forwarded to the subprocess terminal spawn. */
const GRACE_MS = 2000
/** Ring capacity: 512 KiB of raw UTF-8 output bytes per session. */
const RING_CAPACITY = 512 * 1024
/** Pause the PTY output stream once any socket's send queue exceeds this. */
const PAUSE_THRESHOLD = 1024 * 1024
/** Resume once every socket's send queue drains below this. */
const RESUME_THRESHOLD = 256 * 1024
/** Hard cap: a socket still beyond the pause threshold after a grace poll is terminated. */
const DROP_THRESHOLD = 8 * 1024 * 1024
/** Flow-control poll interval while the pump is paused. */
const FLOW_POLL_MS = 250

/** Minimal structural view of `ctx.get('subprocess')`. */
export interface SubprocessLike {
  spawnTerminal(spec: {
    argv: readonly string[]
    cwd: string
    env?: Record<string, string>
    rows: number
    cols: number
    graceMs: number
  }): Promise<SubprocessTerminalHandleLike>
}

/** Minimal structural view of a `SubprocessTerminalHandle`. */
export interface SubprocessTerminalHandleLike {
  readonly pid: number
  readonly output: Readable
  readonly done: Promise<{ exitCode: number | null }>
  write(data: string): Promise<void>
  signalForeground(signal: TerminalSignal): Promise<number>
  terminate(): Promise<void>
}

/** Minimal structural view of `ctx.get('sandbox')`. */
export interface SandboxLike {
  confine(argv: readonly string[], policy: unknown): { argv: string[] } | Promise<{ argv: string[] }>
}

/** Minimal structural view of `ctx.get('sandboxPolicy')`. */
export interface SandboxPolicyLike {
  resolve(request?: { session?: unknown }): { mode: string }
}

/** Minimal structural view of the agent object resolved by the typert lookup. */
export interface AgentLike {
  session: { header: { cwd?: string; id?: string } }
  ctx: { effect(dispose: () => () => void | Promise<void>, label?: string): unknown }
}

/** Minimal structural view of one attached browser socket (satisfied by `ws`). */
export interface PtySocket {
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
  terminate(): void
  readonly bufferedAmount: number
}

/** Public view of one PTY session (internal pump state stays private). */
export interface PtySession {
  readonly sessionId: string
  readonly tabId: string
  readonly name: string
  readonly createdAt: number
  readonly ring: RingBuffer
  status: 'alive' | 'exited'
  exitCode: number | null
  readonly attached: Set<PtySocket>
  info(): TerminalTabInfo
}

interface PtySessionRecord {
  readonly sessionId: string
  readonly tabId: string
  readonly name: string
  readonly createdAt: number
  readonly ring: RingBuffer
  status: 'alive' | 'exited'
  exitCode: number | null
  readonly attached: Set<PtySocket>
  readonly handle: SubprocessTerminalHandleLike
  paused: boolean
  flowTimer: ReturnType<typeof setInterval> | undefined
  info(): TerminalTabInfo
}

/** Bounded FIFO byte buffer that drops the oldest bytes on overflow. */
export class RingBuffer {
  private readonly chunk: Buffer
  private start = 0
  private length = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('RingBuffer capacity must be a positive integer')
    this.chunk = Buffer.allocUnsafe(capacity)
  }

  get size(): number {
    return this.length
  }

  /** Copy bytes in, discarding the oldest overflow. */
  write(data: Buffer): void {
    if (data.length >= this.capacity) {
      this.chunk.fill(data.subarray(data.length - this.capacity), 0)
      this.start = 0
      this.length = this.capacity
      return
    }
    const overflow = this.length + data.length - this.capacity
    if (overflow > 0) this.discard(overflow)
    const end = (this.start + this.length) % this.capacity
    const first = Math.min(data.length, this.capacity - end)
    data.copy(this.chunk, end, 0, first)
    if (first < data.length) data.copy(this.chunk, 0, first)
    this.length += data.length
  }

  /** Concatenated copy of the retained bytes, in write order. */
  snapshot(): Buffer {
    const out = Buffer.allocUnsafe(this.length)
    const first = Math.min(this.length, this.capacity - this.start)
    this.chunk.copy(out, 0, this.start, this.start + first)
    if (first < this.length) this.chunk.copy(out, first, 0, this.length - first)
    return out
  }

  private discard(count: number): void {
    this.start = (this.start + count) % this.capacity
    this.length -= count
  }
}

function sessionKey(sessionId: string, tabId: string): string {
  return `${sessionId}\u0000${tabId}`
}

function shQuote(value: string): string {
  return value.replace(/[\\"$`]/g, '\\$&')
}

export interface PtySpawnDeps {
  subprocess?: SubprocessLike
  sandbox?: SandboxLike
  sandboxPolicy?: SandboxPolicyLike
}

/**
 * Registry of live PTY sessions keyed by (dsh sessionId, tabId). Owns the
 * output pump (ring write + broadcast + backpressure) and the cleanup hooks
 * for owner-session disposal and host shutdown.
 */
export class PtySessionManager {
  private readonly sessions = new Map<string, PtySessionRecord>()
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly deps: PtySpawnDeps = {},
    private readonly ringCapacity: number = RING_CAPACITY,
  ) {
    this.ctx.effect(() => () => { void this.disposeAll() }, 'dsh-terminal: pty host cleanup')
  }

  /** Why spawning is currently unavailable, or undefined when it is available. */
  unavailableReason(): string | undefined {
    if (this.deps.subprocess === undefined && this.ctx.get('subprocess') === undefined) {
      return 'subprocess 服务未加载'
    }
    return undefined
  }

  /**
   * Spawn an interactive shell for one tab and register it. The argv is
   * wrapped in `/bin/sh -c` so the child re-exports TERM/COLORTERM (the
   * upstream spawn hardcodes node-pty `name: 'dumb'`, which always overrides
   * env.TERM).
   *
   * The shell runs unsandboxed by default: every input byte comes from the
   * human user on the loopback-only web UI, while the session sandbox exists
   * to constrain model-initiated actions — confining the user's own
   * interactive shell just breaks zsh init (history lock, completion cache,
   * theme output). Set DSH_TERMINAL_SANDBOX=1 to restore the session-policy
   * confinement.
   */
  async spawn(agent: AgentLike, name: string): Promise<PtySession> {
    const subprocess = this.deps.subprocess ?? (this.ctx.get('subprocess') as SubprocessLike | undefined)
    if (subprocess === undefined) throw new Error('交互终端不可用：subprocess 服务未加载')
    const sessionId = agent.session.header.id
    const cwd = agent.session.header.cwd
    if (sessionId === undefined || sessionId.trim() === '') throw new Error('当前会话没有会话 ID')
    if (cwd === undefined || cwd.trim() === '') throw new Error('当前会话没有项目目录')
    if (this.disposed) throw new Error('PTY 会话管理器已停止')

    const userShell = process.env.SHELL || '/bin/bash'
    let finalArgv: readonly string[] = [
      '/bin/sh', '-c',
      `export TERM=xterm-256color COLORTERM=truecolor; exec "${shQuote(userShell)}" -i`,
    ]
    if (process.env.DSH_TERMINAL_SANDBOX === '1') {
      const policy = (this.deps.sandboxPolicy ?? (this.ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined))
        ?.resolve({ session: agent.session })
      if (policy !== undefined && policy.mode !== 'danger-full-access') {
        const sandbox = this.deps.sandbox ?? (this.ctx.get('sandbox') as SandboxLike | undefined)
        if (sandbox === undefined) {
          throw new Error(`交互终端不可用：沙箱模式 "${policy.mode}" 需要 sandbox 服务`)
        }
        finalArgv = (await sandbox.confine(finalArgv, policy)).argv
      }
    }

    const handle = await subprocess.spawnTerminal({
      argv: finalArgv,
      cwd,
      env: { DSH_TERM_SHELL: userShell },
      rows: DEFAULT_ROWS,
      cols: DEFAULT_COLS,
      graceMs: GRACE_MS,
    })

    const record: PtySessionRecord = {
      sessionId,
      tabId: 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name,
      createdAt: Date.now(),
      ring: new RingBuffer(this.ringCapacity),
      status: 'alive',
      exitCode: null,
      attached: new Set<PtySocket>(),
      handle,
      paused: true,
      flowTimer: undefined,
      info() {
        return { id: this.tabId, name: this.name, status: this.status, exitCode: this.exitCode, createdAt: this.createdAt }
      },
    }
    this.sessions.set(sessionKey(sessionId, record.tabId), record)
    this.wirePump(record)
    // Dsh-session teardown kills every PTY spawned under that agent (same
    // pattern as the harness TerminalSessionService owner cleanup).
    agent.ctx.effect(() => () => { void this.disposeOwned(sessionId) }, 'dsh-terminal: pty owner cleanup')
    return record
  }

  get(sessionId: string, tabId: string): PtySession | undefined {
    return this.sessions.get(sessionKey(sessionId, tabId))
  }

  list(sessionId: string): PtySession[] {
    return [...this.sessions.values()].filter(record => record.sessionId === sessionId)
  }

  /** Deliver an explicit foreground signal; false when the session is gone or exited. */
  async signal(sessionId: string, tabId: string, signal: TerminalSignal): Promise<boolean> {
    const record = this.sessions.get(sessionKey(sessionId, tabId))
    if (record === undefined || record.status !== 'alive') return false
    try {
      await record.handle.signalForeground(signal)
      return true
    } catch {
      return false
    }
  }

  /** Deliver stdin text to one session; drops it when gone or exited. */
  feed(sessionId: string, tabId: string, data: string): void {
    const record = this.sessions.get(sessionKey(sessionId, tabId))
    if (record === undefined || record.status !== 'alive') return
    void record.handle.write(data).catch(() => {
      // A dead pty rejects writes; the exit frame is the real signal.
    })
  }

  /** Terminate and remove one tab; false when the key is unknown. */
  async kill(sessionId: string, tabId: string): Promise<boolean> {
    const record = this.sessions.get(sessionKey(sessionId, tabId))
    if (record === undefined) return false
    await this.disposeRecord(record, 1000)
    return true
  }

  /**
   * Attach one socket as the tab's live observer (one observer per tab).
   * With `replay`, the caller must send the returned snapshot after the
   * confirmation frame and before switching to live bytes; ordering is safe
   * because this runs synchronously inside the socket's message handler.
   */
  attach(sessionId: string, tabId: string, socket: PtySocket, replay: boolean):
    { ok: true; replayBytes: Buffer } | { ok: false; code: 'SESSION_NOT_FOUND' | 'TAB_NOT_FOUND' | 'TAB_ALREADY_ATTACHED' } {
    const record = this.sessions.get(sessionKey(sessionId, tabId))
    if (record === undefined) {
      const sessionExists = [...this.sessions.values()].some(item => item.sessionId === sessionId)
      return { ok: false, code: sessionExists ? 'TAB_NOT_FOUND' : 'SESSION_NOT_FOUND' }
    }
    if (record.attached.size > 0) {
      return { ok: false, code: 'TAB_ALREADY_ATTACHED' }
    }
    record.attached.add(socket)
    this.applyFlow(record)
    return { ok: true, replayBytes: replay ? record.ring.snapshot() : Buffer.alloc(0) }
  }

  detach(socket: PtySocket): void {
    for (const record of this.sessions.values()) {
      if (!record.attached.delete(socket)) continue
      this.applyFlow(record)
    }
  }

  /** Kill every tab belonging to one dsh session (owner cleanup hook). */
  async disposeOwned(sessionId: string): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter(record => record.sessionId === sessionId)
      .map(record => this.disposeRecord(record, 1000)))
  }

  /** Kill everything (host/plugin teardown hook). */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.sessions.values()].map(record => this.disposeRecord(record, 1001)))
  }

  private wirePump(record: PtySessionRecord): void {
    const { handle } = record
    handle.output.on('data', (chunk: Buffer) => {
      record.ring.write(chunk)
      this.broadcast(record, chunk)
      this.applyFlow(record)
    })
    void handle.done.then(
      (outcome) => { this.markExited(record, outcome.exitCode) },
      () => { this.markExited(record, null) },
    )
    // No observer yet: keep the pty output parked until the first attach.
    handle.output.pause()
  }

  private broadcast(record: PtySessionRecord, chunk: Buffer): void {
    for (const socket of record.attached) {
      if (socket.bufferedAmount > DROP_THRESHOLD) {
        // Slow consumer beyond the hard cap: drop the socket, not the host.
        // The error frame would queue behind the backlog it can't drain, so
        // the abrupt close is the signal; the client recovers by reconnecting
        // and replaying from the ring.
        socket.terminate()
        record.attached.delete(socket)
        continue
      }
      socket.send(chunk)
    }
  }

  private markExited(record: PtySessionRecord, exitCode: number | null): void {
    if (record.status === 'exited') return
    record.status = 'exited'
    record.exitCode = exitCode
    const frame = encodeFrame({ type: 'exit', exitCode })
    for (const socket of record.attached) socket.send(frame)
    this.applyFlow(record)
  }

  /**
   * Pause the pump while any socket is backed up (or none is attached) and
   * resume once every queue is small again; a slow poll drives the resume
   * because `ws` has no drain callback.
   */
  private applyFlow(record: PtySessionRecord): void {
    const shouldPause = record.attached.size === 0
      || [...record.attached].some(socket => socket.bufferedAmount > PAUSE_THRESHOLD)
    if (shouldPause) {
      if (!record.paused) {
        record.paused = true
        record.handle.output.pause()
      }
      // With no observer there is nothing to drain; the next attach re-runs
      // this check, so the slow poll is only worth running under backpressure.
      if (record.attached.size > 0 && record.flowTimer === undefined) {
        record.flowTimer = setInterval(() => this.pollFlow(record), FLOW_POLL_MS)
      }
      return
    }
    if (record.paused && ![...record.attached].some(socket => socket.bufferedAmount > RESUME_THRESHOLD)) {
      record.paused = false
      this.clearFlowTimer(record)
      record.handle.output.resume()
    }
  }

  private pollFlow(record: PtySessionRecord): void {
    for (const socket of [...record.attached]) {
      if (socket.bufferedAmount > DROP_THRESHOLD) {
        socket.terminate()
        record.attached.delete(socket)
      }
    }
    this.applyFlow(record)
  }

  private clearFlowTimer(record: PtySessionRecord): void {
    if (record.flowTimer === undefined) return
    clearInterval(record.flowTimer)
    record.flowTimer = undefined
  }

  private async disposeRecord(record: PtySessionRecord, closeCode: number): Promise<void> {
    if (!this.sessions.delete(sessionKey(record.sessionId, record.tabId))) return
    this.clearFlowTimer(record)
    record.paused = true
    record.handle.output.pause()
    record.handle.output.removeAllListeners('data')
    for (const socket of record.attached) {
      try {
        socket.close(closeCode, 'session closed')
      } catch {
        socket.terminate()
      }
    }
    record.attached.clear()
    try {
      await record.handle.terminate()
    } catch {
      // Terminate is documented idempotent; a rejection here is still safe to swallow.
    }
  }
}
