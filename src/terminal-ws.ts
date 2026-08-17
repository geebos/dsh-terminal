/**
 * Plugin-private WebSocket data plane at `/plugins/dsh-terminal/ws`. One
 * connection proxies one tab: text frames are JSON control frames, binary
 * frames are raw terminal bytes. The upgrade handshake runs a trust fence
 * (Origin must be same-origin with the Host, which must be loopback or the
 * bound address) so cross-site pages and DNS-rebinding domains cannot reach
 * the PTY stream. This channel never crosses the `/api` gateway, so the fence
 * here is the whole security story for the data plane.
 */

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type { PtySessionManager } from './pty-session.ts'
import { TERMINAL_WS_PATH, encodeFrame, parseClientFrame, type AttachedFrame } from './protocol.ts'

/** Minimal structural view of `ctx.get('webServer')`. */
interface WebServerLike {
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
  readonly host: string
}

const PING_INTERVAL_MS = 30_000
/** Terminate after this many consecutive ping cycles without a pong. */
const MAX_MISSED_PINGS = 2
/** Keystrokes and pastes are tiny; anything larger is protocol abuse. */
const MAX_PAYLOAD_BYTES = 64 * 1024

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Trust fence for the upgrade handshake. Browsers always attach Origin to a
 * WebSocket open, so a missing Origin is refused (curl probes included); the
 * Host header must name loopback or the server's bound literal, which a
 * rebound page cannot forge.
 */
export function isTrustedUpgrade(headers: IncomingHttpHeaders, boundHost: string): boolean {
  const host = header(headers, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname) && hostUrl.hostname !== boundHost) return false
  if (header(headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(headers, 'origin')
  if (origin === undefined || origin === 'null') return false
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Owns the no-server WebSocket acceptor and the per-connection state machine. */
export class TerminalWsGateway {
  private readonly wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD_BYTES,
  })
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly manager: PtySessionManager,
  ) {}

  /** Register the upgrade route when the web composition is present; no-op otherwise. */
  start(): void {
    if (this.started) return
    const webServer = this.ctx.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    this.started = true
    const disposeRoute = webServer.registerUpgrade({
      path: TERMINAL_WS_PATH,
      handler: (req, socket, head) => {
        void this.handleUpgradeRequest(webServer.host, req, socket, head)
      },
    })
    this.ctx.effect(() => () => {
      disposeRoute()
      for (const client of this.wss.clients) client.terminate()
      void this.closeServer()
    }, 'dsh-terminal: ws gateway cleanup')
  }

  /** Trust-fence one raw upgrade request, then accept it onto the acceptor. */
  handleUpgradeRequest(boundHost: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isTrustedUpgrade(req.headers, boundHost)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      this.onConnection(ws)
    })
  }

  private async closeServer(): Promise<void> {
    await new Promise<void>(resolve => {
      this.wss.close(() => { resolve() })
    })
  }

  private onConnection(ws: WebSocket): void {
    let attached: { sessionId: string; tabId: string } | null = null
    let missedPings = 0
    ws.on('pong', () => { missedPings = 0 })
    const heartbeat = setInterval(() => {
      if (missedPings >= MAX_MISSED_PINGS) {
        ws.terminate()
        return
      }
      missedPings += 1
      ws.ping()
    }, PING_INTERVAL_MS)
    const cleanup = (): void => {
      clearInterval(heartbeat)
      this.manager.detach(ws)
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (attached === null) {
          ws.close(1002, 'attach required')
          return
        }
        this.manager.feed(attached.sessionId, attached.tabId, data.toString('utf8'))
        return
      }
      const frame = parseClientFrame(data.toString('utf8'))
      if (frame === undefined) {
        ws.close(1002, 'malformed control frame')
        return
      }
      if (attached === null) {
        if (frame.type !== 'attach') {
          ws.close(1002, 'attach required')
          return
        }
        if (!this.handleAttach(ws, frame.sessionId, frame.tabId, frame.replay)) return
        attached = { sessionId: frame.sessionId, tabId: frame.tabId }
        return
      }
      if (frame.type === 'attach') {
        ws.close(1002, 'already attached')
        return
      }
      if (frame.type === 'signal') {
        void this.manager.signal(attached.sessionId, attached.tabId, frame.signal)
        return
      }
      ws.send(encodeFrame({
        type: 'error',
        code: 'RESIZE_UNSUPPORTED',
        message: 'terminal resize waits on an upstream handle.resize API',
      }))
    })
  }

  private handleAttach(ws: WebSocket, sessionId: string, tabId: string, replay: boolean): boolean {
    const result = this.manager.attach(sessionId, tabId, ws, replay)
    if (!result.ok) {
      ws.send(encodeFrame({ type: 'error', code: result.code, message: `attach rejected: ${result.code}` }))
      ws.close(1011, result.code)
      return false
    }
    const session = this.manager.get(sessionId, tabId)
    const attachedFrame: AttachedFrame = {
      type: 'attached',
      replayBytes: result.replayBytes.length,
      status: session?.status ?? 'alive',
      ...(session?.status === 'exited' ? { exitCode: session.exitCode } : {}),
    }
    ws.send(encodeFrame(attachedFrame))
    if (result.replayBytes.length > 0) ws.send(result.replayBytes)
    return true
  }
}
