/**
 * dsh-terminal plugin, browser half. Renders a collapsible interactive
 * terminal above the composer: tab metadata and quick commands go through
 * the `terminal` Remote namespace (control plane), terminal bytes through
 * the plugin's private WebSocket (data plane, see pty-connection.ts).
 */

import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TerminalCloseTabValue,
  TerminalCommand,
  TerminalCreateTabValue,
  TerminalListValue,
  TerminalSaveValue,
  TerminalSignal,
  TerminalSignalValue,
} from '../types.ts'
import { TYPERT_REMOTE } from '../remote.ts'
import { PACKAGE_NAME } from '../typert-descriptors.ts'
import { en, NS, zh, type TerminalKey } from './locales.ts'
import Terminal, { TERMINAL_CSS } from './terminal.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Terminal chrome and quick-command settings copy. */
    'dsh-terminal': TerminalKey
  }
}

/** Scoped remote namespace resolved from one Session scope. */
interface TerminalRemote {
  list: () => Promise<RemoteResult<TerminalListValue>>
  save: (commands: TerminalCommand[]) => Promise<RemoteResult<TerminalSaveValue>>
  createTab: () => Promise<RemoteResult<TerminalCreateTabValue>>
  closeTab: (tabId: string) => Promise<RemoteResult<TerminalCloseTabValue>>
  signalTab: (tabId: string, signal: TerminalSignal) => Promise<RemoteResult<TerminalSignalValue>>
}

export const inject = ['slots', 'sessions', 'remote', 'locale']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const sessions = (ctx as unknown as { sessions: ISessions }).sessions

  const style = document.createElement('style')
  style.dataset.plugin = PACKAGE_NAME
  style.textContent = TERMINAL_CSS
  document.head.appendChild(style)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-terminal: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    {
      name: 'conversation.input.dock',
      id: 'interactive-terminal',
      order: 30,
      locale: NS,
      inject: (sessionId: SessionId) => {
        const scope = sessions.scope(sessionId)
        const remote = scope?.get('remote.terminal') as TerminalRemote | undefined
        const unwrap = <T,>(carried: RemoteResult<T>): T => {
          if (!carried.ok) throw new Error(carried.error.message)
          return carried.value
        }
        const unavailable = (): Error => new Error('Terminal service unavailable')
        return {
          listState: async (): Promise<TerminalListValue> => {
            if (remote === undefined) throw unavailable()
            return unwrap(await remote.list())
          },
          saveCommands: async (commands: TerminalCommand[]): Promise<TerminalSaveValue> => {
            if (remote === undefined) throw unavailable()
            return unwrap(await remote.save(commands))
          },
          createTab: async (): Promise<TerminalCreateTabValue> => {
            if (remote === undefined) throw unavailable()
            return unwrap(await remote.createTab())
          },
          closeTab: async (tabId: string): Promise<TerminalCloseTabValue> => {
            if (remote === undefined) throw unavailable()
            return unwrap(await remote.closeTab(tabId))
          },
          signalTab: async (tabId: string, signal: TerminalSignal): Promise<TerminalSignalValue> => {
            if (remote === undefined) throw unavailable()
            return unwrap(await remote.signalTab(tabId, signal))
          },
        }
      },
    },
    Terminal,
  ))

  return async () => {
    style.remove()
    await disposeRemote()
  }
}
