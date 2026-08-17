/** Shared fakes for the host-half tests. */

import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentLike, PtySocket, SubprocessLike, SubprocessTerminalHandleLike } from '../src/pty-session.ts'

export class FakeHandle implements SubprocessTerminalHandleLike {
  readonly pid = 4321
  readonly output = new PassThrough()
  readonly doneResolvers = Promise.withResolvers<{ exitCode: number | null }>()
  readonly writes: string[] = []
  readonly signals: string[] = []
  terminated = 0

  get done(): Promise<{ exitCode: number | null }> {
    return this.doneResolvers.promise
  }

  async write(data: string): Promise<void> {
    this.writes.push(data)
  }

  async signalForeground(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'): Promise<number> {
    this.signals.push(signal)
    return 1
  }

  async terminate(): Promise<void> {
    this.terminated += 1
  }
}

export class FakeSubprocess implements SubprocessLike {
  readonly handles: FakeHandle[] = []
  readonly specs: unknown[] = []

  async spawnTerminal(spec: Parameters<SubprocessLike['spawnTerminal']>[0]): Promise<FakeHandle> {
    this.specs.push(spec)
    const handle = new FakeHandle()
    this.handles.push(handle)
    return handle
  }
}

export class FakeSocket implements PtySocket {
  readonly sent: (string | Buffer)[] = []
  bufferedAmount = 0
  closedWith: number | null = null
  terminated = false

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closedWith = code ?? null
  }

  terminate(): void {
    this.terminated = true
  }

  controlFrames(): unknown[] {
    return this.sent
      .filter((item): item is string => typeof item === 'string')
      .map(text => JSON.parse(text))
  }

  byteStream(): Buffer {
    return Buffer.concat(this.sent.filter((item): item is Buffer => typeof item !== 'string'))
  }
}

/**
 * Cordis context stub: `get` resolves nothing (managers must take their
 * services through explicit deps), `effect` registers without running the
 * cleanup.
 */
export function stubContext(): Context {
  return {
    get: () => undefined,
    effect: (dispose: () => unknown) => dispose(),
  } as unknown as Context
}

export function fakeAgent(sessionId = 'sess-1', cwd = '/tmp/proj'): { agent: AgentLike; cleanup: () => void } {
  const cleanups: (() => void)[] = []
  return {
    agent: {
      session: { header: { id: sessionId, cwd } },
      ctx: {
        effect: (dispose: () => () => void) => {
          const disposer = dispose()
          cleanups.push(() => { void disposer() })
          return () => {}
        },
      },
    },
    cleanup: () => { for (const run of cleanups) run() },
  }
}

/** One macrotask tick, enough for stream data events to settle. */
export const flush = async (): Promise<void> => {
  await new Promise(resolve => process.nextTick(resolve))
}
