/**
 * Host-side terminal service published as the `terminal` Remote namespace:
 * the control plane. It manages quick-command persistence under the project's
 * `.dsh-terminal/` directory (plugin-owned state written through `node:fs`
 * directly, like the file-review service) and drives the PtySessionManager
 * for tab metadata, spawning, closing, and explicit signals. Terminal bytes
 * never travel through this service — they belong to the plugin's private
 * WebSocket data plane (see terminal-ws.ts).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  PtySessionManager,
  type AgentLike,
  type PtySession,
} from './pty-session.ts'
import type {
  TerminalCloseTabValue,
  TerminalCommand,
  TerminalCreateTabValue,
  TerminalListValue,
  TerminalSaveValue,
  TerminalSignalValue,
  TerminalTabInfo,
} from './types.ts'

const DIR_NAME = '.dsh-terminal'
const COMMANDS_FILE = 'commands.json'
const GITIGNORE_FILE = '.gitignore'
const GITIGNORE_CONTENT = '*\n'

function errText(error: unknown): string {
  const message = (error as { message?: string } | null)?.message
  return message === undefined ? String(error) : message
}

function normalizeArray<T>(parsed: unknown): T[] {
  return Array.isArray(parsed) ? (parsed as T[]) : []
}

function toInfo(session: PtySession): TerminalTabInfo {
  return session.info()
}

function nextTabName(tabs: TerminalTabInfo[]): string {
  let max = 0
  for (const tab of tabs) {
    const m = /^tab(\d+)$/.exec(tab.name)
    if (m !== null) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `tab${max + 1}`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Host service published as the `terminal` Remote namespace. */
export class TerminalService extends TypertRemoteService {
  private readonly commandsCache = new Map<string, TerminalCommand[]>()
  readonly manager: PtySessionManager

  constructor(ctx: Context) {
    super(ctx, 'terminal')
    this.manager = new PtySessionManager(ctx)
  }

  private static sessionId(agent: AgentLike): string {
    const id = agent.session.header.id
    if (id === undefined || id.trim() === '') throw new Error('当前会话没有会话 ID')
    return id
  }

  private static cwd(agent: AgentLike): string {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.trim() === '') throw new Error('当前会话没有项目目录')
    return cwd
  }

  private async readJson<T>(path: string): Promise<T[]> {
    try {
      return normalizeArray<T>(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      return []
    }
  }

  /** Bootstrap `.dsh-terminal/` with a `.gitignore` that ignores every file inside it. */
  private async ensureGitignore(cwd: string): Promise<void> {
    await mkdir(join(cwd, DIR_NAME), { recursive: true })
    const gitignore = join(cwd, DIR_NAME, GITIGNORE_FILE)
    if (!(await pathExists(gitignore))) {
      await writeFile(gitignore, GITIGNORE_CONTENT, 'utf8')
    }
  }

  private async loadCommands(cwd: string): Promise<TerminalCommand[]> {
    const cached = this.commandsCache.get(cwd)
    if (cached !== undefined) return cached
    const commands = await this.readJson<TerminalCommand>(join(cwd, DIR_NAME, COMMANDS_FILE))
    this.commandsCache.set(cwd, commands)
    return commands
  }

  /** Read quick commands (shared) and this dsh session's PTY tabs (host memory). */
  async list(agent: AgentLike): Promise<TerminalListValue> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.trim() === '') {
      return { commands: [], tabs: [], warning: '当前会话没有项目目录' }
    }
    const sessionId = TerminalService.sessionId(agent)
    const commands = await this.loadCommands(cwd)
    const tabs = this.manager.list(sessionId).map(toInfo)
    const unavailable = this.manager.unavailableReason()
    if (unavailable !== undefined) {
      return { commands, tabs, warning: `交互终端不可用：${unavailable}` }
    }
    return { commands, tabs }
  }

  /** Persist the quick-command list for the current project (shared across sessions). */
  async save(agent: AgentLike, commands: TerminalCommand[]): Promise<TerminalSaveValue> {
    const cwd = TerminalService.cwd(agent)
    this.commandsCache.set(cwd, commands)
    try {
      await this.ensureGitignore(cwd)
      await writeFile(join(cwd, DIR_NAME, COMMANDS_FILE), JSON.stringify(commands, null, 2), 'utf8')
      return { persisted: true }
    } catch (error) {
      return { persisted: false, warning: '已保存在内存（未能写入项目文件）: ' + errText(error) }
    }
  }

  /** Spawn a new interactive PTY tab for this dsh session. */
  async createTab(agent: AgentLike): Promise<TerminalCreateTabValue> {
    const sessionId = TerminalService.sessionId(agent)
    const name = nextTabName(this.manager.list(sessionId).map(toInfo))
    const session = await this.manager.spawn(agent, name)
    return { tab: session.info() }
  }

  /** Terminate and remove one tab; returns the session's remaining tabs. */
  async closeTab(agent: AgentLike, tabId: string): Promise<TerminalCloseTabValue> {
    const sessionId = TerminalService.sessionId(agent)
    const killed = await this.manager.kill(sessionId, tabId)
    if (!killed) throw new Error('找不到目标标签页')
    return { tabs: this.manager.list(sessionId).map(toInfo) }
  }

  /** Deliver an explicit foreground signal to one tab (kill button). */
  async signalTab(agent: AgentLike, tabId: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'): Promise<TerminalSignalValue> {
    const sessionId = TerminalService.sessionId(agent)
    return { delivered: await this.manager.signal(sessionId, tabId, signal) }
  }
}
