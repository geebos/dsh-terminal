/** Shared JSON business types crossing the Host service and browser remote. */

/** Explicit foreground signals (member-identical to the subprocess terminal primitive). */
export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

export interface TerminalCommand {
  id: string
  alias: string
  command: string
}

/** One host-side PTY tab: alive while the shell runs, retained after exit for replay. */
export interface TerminalTabInfo {
  id: string
  name: string
  status: 'alive' | 'exited'
  exitCode: number | null
  createdAt: number
}

export interface TerminalListValue {
  commands: TerminalCommand[]
  tabs: TerminalTabInfo[]
  warning?: string
}

export interface TerminalSaveValue {
  persisted: boolean
  warning?: string
}

export interface TerminalCreateTabValue {
  tab: TerminalTabInfo
  warning?: string
}

export interface TerminalCloseTabValue {
  tabs: TerminalTabInfo[]
  warning?: string
}

export interface TerminalSignalValue {
  delivered: boolean
}
