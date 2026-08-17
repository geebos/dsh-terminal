/** Browser Typert contribution for the Host terminal service. */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TerminalCloseTabValue,
  TerminalCommand,
  TerminalCreateTabValue,
  TerminalListValue,
  TerminalSaveValue,
  TerminalSignal,
  TerminalSignalValue,
} from './types.ts'
import { PACKAGE_NAME, TERMINAL_INVOCATIONS } from './typert-descriptors.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    terminal: {
      list: (agentId: string) => Promise<RemoteResult<TerminalListValue>>
      save: (agentId: string, commands: TerminalCommand[]) => Promise<RemoteResult<TerminalSaveValue>>
      createTab: (agentId: string) => Promise<RemoteResult<TerminalCreateTabValue>>
      closeTab: (agentId: string, tabId: string) => Promise<RemoteResult<TerminalCloseTabValue>>
      signalTab: (agentId: string, tabId: string, signal: TerminalSignal) => Promise<RemoteResult<TerminalSignalValue>>
    }
  }
  interface TypertRemoteMap {
    'terminal/list': (agentId: string) => Promise<RemoteResult<TerminalListValue>>
    'terminal/save': (agentId: string, commands: TerminalCommand[]) => Promise<RemoteResult<TerminalSaveValue>>
    'terminal/createTab': (agentId: string) => Promise<RemoteResult<TerminalCreateTabValue>>
    'terminal/closeTab': (agentId: string, tabId: string) => Promise<RemoteResult<TerminalCloseTabValue>>
    'terminal/signalTab': (agentId: string, tabId: string, signal: TerminalSignal) => Promise<RemoteResult<TerminalSignalValue>>
  }
  interface TypertRemoteScopeMap {
    'agent:terminal/list': () => Promise<RemoteResult<TerminalListValue>>
    'agent:terminal/save': (commands: TerminalCommand[]) => Promise<RemoteResult<TerminalSaveValue>>
    'agent:terminal/createTab': () => Promise<RemoteResult<TerminalCreateTabValue>>
    'agent:terminal/closeTab': (tabId: string) => Promise<RemoteResult<TerminalCloseTabValue>>
    'agent:terminal/signalTab': (tabId: string, signal: TerminalSignal) => Promise<RemoteResult<TerminalSignalValue>>
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE_NAME,
  descriptors: TERMINAL_INVOCATIONS,
}

export default TYPERT_REMOTE
