/**
 * Wire shapes for the plugin-private terminal WebSocket. Text frames are JSON
 * control frames discriminated by `type`; binary frames are raw terminal bytes
 * (stdin up, PTY output down) passed through as UTF-8 without parsing.
 */

import type { TerminalSignal } from './types.ts'

/** Upgrade path this plugin registers on the harness web server. */
export const TERMINAL_WS_PATH = '/plugins/dsh-terminal/ws'

export const TERMINAL_SIGNALS: readonly TerminalSignal[] = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']

export function isTerminalSignal(value: unknown): value is TerminalSignal {
  return typeof value === 'string' && (TERMINAL_SIGNALS as readonly string[]).includes(value)
}

/** C→S first frame; must be the first frame on the connection. */
export interface AttachFrame {
  type: 'attach'
  sessionId: string
  tabId: string
  replay: boolean
  /** Recorded only; the PTY size is fixed at spawn (D1). */
  cols?: number
  rows?: number
}

/** S→C confirmation; replay bytes follow as binary frames before live output. */
export interface AttachedFrame {
  type: 'attached'
  replayBytes: number
  status: 'alive' | 'exited'
  exitCode?: number | null
}

/** S→C live notification that the top-level PTY process exited. */
export interface ExitFrame {
  type: 'exit'
  exitCode: number | null
}

/** C→S explicit foreground signal (Ctrl-C travels as a raw \x03 byte instead). */
export interface SignalFrame {
  type: 'signal'
  signal: TerminalSignal
}

/** C→S reserved for the future resize support; rejected while D1 holds. */
export interface ResizeFrame {
  type: 'resize'
  cols: number
  rows: number
}

export type TerminalErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'TAB_NOT_FOUND'
  | 'TAB_ALREADY_ATTACHED'
  | 'PROTOCOL_VIOLATION'
  | 'RESIZE_UNSUPPORTED'
  | 'BACKPRESSURE_DROP'
  | 'INTERNAL'

export interface ErrorFrame {
  type: 'error'
  code: TerminalErrorCode
  message: string
}

export type ClientControlFrame = AttachFrame | SignalFrame | ResizeFrame
export type ServerControlFrame = AttachedFrame | ExitFrame | ErrorFrame

export function encodeFrame(frame: ServerControlFrame): string {
  return JSON.stringify(frame)
}

/**
 * Decode and structurally validate one client text frame. Returns undefined
 * for anything that is not a well-formed control frame (caller closes 1002).
 */
export function parseClientFrame(text: string): ClientControlFrame | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const frame = parsed as Record<string, unknown>
  if (frame.type === 'attach') {
    if (typeof frame.sessionId !== 'string' || frame.sessionId === '') return undefined
    if (typeof frame.tabId !== 'string' || frame.tabId === '') return undefined
    if (typeof frame.replay !== 'boolean') return undefined
    return { type: 'attach', sessionId: frame.sessionId, tabId: frame.tabId, replay: frame.replay }
  }
  if (frame.type === 'signal') {
    if (!isTerminalSignal(frame.signal)) return undefined
    return { type: 'signal', signal: frame.signal }
  }
  if (frame.type === 'resize') {
    if (typeof frame.cols !== 'number' || !Number.isFinite(frame.cols)) return undefined
    if (typeof frame.rows !== 'number' || !Number.isFinite(frame.rows)) return undefined
    return { type: 'resize', cols: frame.cols, rows: frame.rows }
  }
  return undefined
}
