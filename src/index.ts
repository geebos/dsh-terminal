/**
 * dsh-terminal plugin, node half. Instantiates the terminal Remote service
 * (control plane) and, when the web composition is present, the private PTY
 * WebSocket gateway (data plane). The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration.
 */

import type { Context } from '@deepseek-ai/cordis'
import { TerminalService } from './terminal-service.ts'
import { TerminalWsGateway } from './terminal-ws.ts'

export type * from './types.ts'
export { TerminalService } from './terminal-service.ts'
export { PtySessionManager, RingBuffer } from './pty-session.ts'
export { TerminalWsGateway, isTrustedUpgrade } from './terminal-ws.ts'
export { TERMINAL_WS_PATH } from './protocol.ts'

/**
 * Register the terminal service (and its Typert Gateway binding) plus the
 * PTY WebSocket upgrade route.
 * @param ctx - host context carrying `subprocess` and (in web compositions) `webServer`.
 */
export function apply(ctx: Context): void {
  const service = new TerminalService(ctx)
  new TerminalWsGateway(ctx, service.manager).start()
}
