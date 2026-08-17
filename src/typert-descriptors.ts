/** Strict Typert codecs and invocation descriptors shared by the Host and browser artifacts. */

import { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE_NAME = '@geebos/dsh-terminal'

const commandSchema = z.object({
  id: z.string(),
  alias: z.string(),
  command: z.string(),
})

const tabInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['alive', 'exited']),
  exitCode: z.number().nullable(),
  createdAt: z.number(),
})

const agentCodec = {
  mode: 'strict' as const,
  typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  schema: z.intersection(z.string(), z.unknown()),
}

const listValueCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#TerminalListValue`,
  schema: z.object({
    commands: z.array(commandSchema),
    tabs: z.array(tabInfoSchema),
    warning: z.string().optional(),
  }),
}

const saveValueCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#TerminalSaveValue`,
  schema: z.object({
    persisted: z.boolean(),
    warning: z.string().optional(),
  }),
}

const createTabValueCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#TerminalCreateTabValue`,
  schema: z.object({
    tab: tabInfoSchema,
    warning: z.string().optional(),
  }),
}

const closeTabValueCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#TerminalCloseTabValue`,
  schema: z.object({
    tabs: z.array(tabInfoSchema),
    warning: z.string().optional(),
  }),
}

const signalValueCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#TerminalSignalValue`,
  schema: z.object({
    delivered: z.boolean(),
  }),
}

const commandsCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#TerminalCommand[]`,
  schema: z.array(commandSchema),
}

const tabIdCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#tabId`,
  schema: z.string(),
}

const signalCodec = {
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#signal`,
  schema: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']),
}

export const TERMINAL_INVOCATIONS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#terminal/list`,
    service: 'terminal',
    namespace: 'terminal',
    method: 'list',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
    ],
    result: listValueCodec,
  },
  {
    id: `${PACKAGE_NAME}#terminal/save`,
    service: 'terminal',
    namespace: 'terminal',
    method: 'save',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
      { name: 'commands', wire: 'commands', source: 'json', codec: commandsCodec },
    ],
    result: saveValueCodec,
  },
  {
    id: `${PACKAGE_NAME}#terminal/createTab`,
    service: 'terminal',
    namespace: 'terminal',
    method: 'createTab',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
    ],
    result: createTabValueCodec,
  },
  {
    id: `${PACKAGE_NAME}#terminal/closeTab`,
    service: 'terminal',
    namespace: 'terminal',
    method: 'closeTab',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
      { name: 'tabId', wire: 'tabId', source: 'json', codec: tabIdCodec },
    ],
    result: closeTabValueCodec,
  },
  {
    id: `${PACKAGE_NAME}#terminal/signalTab`,
    service: 'terminal',
    namespace: 'terminal',
    method: 'signalTab',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec },
      { name: 'tabId', wire: 'tabId', source: 'json', codec: tabIdCodec },
      { name: 'signal', wire: 'signal', source: 'json', codec: signalCodec },
    ],
    result: signalValueCodec,
  },
]
