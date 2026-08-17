/**
 * Browser-side data-plane client: one WebSocket per tab against the plugin's
 * private `/plugins/dsh-terminal/ws` endpoint, with an exponential-backoff
 * reconnect state machine. Text frames are JSON control frames; binary frames
 * are raw terminal bytes (stdin up, PTY output down). Keystrokes are dropped
 * locally while not streaming — the PTY owns echo, so keys typed during an
 * outage were never delivered anyway.
 */

import type { TerminalSignal } from '../types.ts'

/** Connection lifecycle. `exited`/`dead`/`closed` are terminal. */
export type PtyConnState = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'exited' | 'dead' | 'closed'

export interface PtyConnDetail {
  /** Present for `exited`. */
  exitCode?: number | null
  /** Present on `streaming` when the PTY already exited before this attach. */
  status?: 'alive' | 'exited'
  /** Present for `dead` (attach rejected: session gone after a host restart). */
  reason?: string
}

export interface PtyConnectionCallbacks {
  /** One live PTY output chunk, already UTF-8 decoded with stream continuity. */
  onData: (text: string) => void
  /** State transitions; `streaming` fires after each successful (re)attach. */
  onState: (state: PtyConnState, detail?: PtyConnDetail) => void
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000
/** Attach rejections that mean "this tab no longer exists on the host". */
const DEAD_CODES = new Set(['SESSION_NOT_FOUND', 'TAB_NOT_FOUND'])

function wsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/plugins/dsh-terminal/ws`
}

export class PtyConnection {
  private state: PtyConnState = 'idle'
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay = RECONNECT_BASE_MS
  private readonly decoder = new TextDecoder('utf-8')
  private readonly encoder = new TextEncoder()
  /** Keystrokes dropped while not streaming (diagnostic only). */
  private dropped = 0

  constructor(
    private readonly sessionId: string,
    private readonly tabId: string,
    private readonly cols: number,
    private readonly rows: number,
    private readonly callbacks: PtyConnectionCallbacks,
  ) {}

  get currentState(): PtyConnState {
    return this.state
  }

  open(): void {
    if (this.state !== 'idle' && this.state !== 'reconnecting') return
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(JSON.stringify({
        type: 'attach',
        sessionId: this.sessionId,
        tabId: this.tabId,
        replay: true,
        cols: this.cols,
        rows: this.rows,
      }))
    }
    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      if (typeof event.data === 'string') {
        this.handleControl(event.data)
        return
      }
      // Streaming decoder: split multibyte sequences carry across chunks.
      this.callbacks.onData(this.decoder.decode(event.data as ArrayBuffer, { stream: true }))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.state === 'streaming' || this.state === 'connecting') this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows; reconnect logic lives there.
    }
  }

  /** Send stdin text as a binary frame; dropped unless streaming. */
  send(data: string): void {
    if (this.state !== 'streaming' || this.ws === null) {
      this.dropped += data.length
      return
    }
    this.ws.send(this.encoder.encode(data))
  }

  /** Send an explicit foreground signal (the kill button). */
  signal(signal: TerminalSignal): void {
    if (this.state !== 'streaming' || this.ws === null) return
    this.ws.send(JSON.stringify({ type: 'signal', signal }))
  }

  /**
   * User-initiated close; stops the reconnect loop. Deliberately silent: it
   * runs from React teardown paths where a synchronous onState callback
   * would schedule renders during commit, so no `onState('closed')` fires.
   */
  close(): void {
    this.clearReconnectTimer()
    const ws = this.ws
    this.ws = null
    if (ws !== null) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
    }
    this.state = 'closed'
  }

  private handleControl(text: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') return
    const type = (frame as { type?: unknown }).type
    if (type === 'attached') {
      // Fresh attach: the replay that follows rebuilds the viewport from
      // scratch, so clear anything buffered from the previous incarnation.
      this.reconnectDelay = RECONNECT_BASE_MS
      const attached = frame as { status?: unknown; exitCode?: unknown }
      const detail: PtyConnDetail = {}
      if (attached.status === 'alive' || attached.status === 'exited') detail.status = attached.status
      if (typeof attached.exitCode === 'number' || attached.exitCode === null) detail.exitCode = attached.exitCode
      this.setState('streaming', detail)
      return
    }
    if (type === 'exit') {
      this.clearReconnectTimer()
      const code = (frame as { exitCode?: unknown }).exitCode
      const detail: PtyConnDetail = {}
      if (typeof code === 'number' || code === null) detail.exitCode = code
      this.setState('exited', detail)
      this.closeSocketQuietly()
      return
    }
    if (type === 'error') {
      const code = (frame as { code?: unknown }).code
      if (typeof code === 'string' && DEAD_CODES.has(code)) {
        this.clearReconnectTimer()
        this.setState('dead', { reason: code })
        this.closeSocketQuietly()
      }
      // Other error codes (e.g. RESIZE_UNSUPPORTED) are advisory only.
      return
    }
  }

  private closeSocketQuietly(): void {
    const ws = this.ws
    this.ws = null
    if (ws === null) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    ws.close()
  }

  private scheduleReconnect(): void {
    if (this.state === 'exited' || this.state === 'dead' || this.state === 'closed') return
    this.setState('reconnecting')
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private setState(state: PtyConnState, detail?: PtyConnDetail): void {
    this.state = state
    this.callbacks.onState(state, detail)
  }
}
