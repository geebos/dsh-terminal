/** Host Typert contribution discovered through the package's `./typert` export. */

import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { PACKAGE_NAME, TERMINAL_INVOCATIONS } from './typert-descriptors.ts'

export const TYPERT: TypertContribution = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  invocations: TERMINAL_INVOCATIONS,
  model: {
    services: [{
      key: 'terminal',
      exportName: 'TerminalService',
      summary: 'Manage interactive PTY tabs and per-project quick commands for the browser terminal.',
      tags: [],
      members: [],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
