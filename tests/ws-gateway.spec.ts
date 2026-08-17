/**
 * Gateway integration test: a real node HTTP server with the upgrade route
 * wired the way the harness webServer would, plus a real `ws` browser-side
 * client. Exercises the trust fence on genuine handshakes and the full
 * frame protocol (attach/replay/stdin/exit/errors).
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PtySessionManager } from '../src/pty-session.ts'
import { TerminalWsGateway } from '../src/terminal-ws.ts'
import { FakeHandle, FakeSubprocess, fakeAgent, stubContext } from './helpers.ts'

interface FakeWebServer {
  server: Server
  host: string
  port: number
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

function startFakeWebServer(): Promise<FakeWebServer> {
  const routes = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>>()
  const server = createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (handler === undefined) {
      socket.destroy()
      return
    }
    void handler(req, socket, head)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) throw new Error('expected tcp address')
      resolve({
        server,
        host: '127.0.0.1',
        port: address.port,
        registerUpgrade(route) {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      })
    })
  })
}

interface Harness {
  web: FakeWebServer
  manager: PtySessionManager
  subprocess: FakeSubprocess
}

async function boot(): Promise<Harness> {
  const web = await startFakeWebServer()
  const subprocess = new FakeSubprocess()
  const manager = new PtySessionManager(stubContext(), { subprocess }, 64 * 1024)
  const gateway = new TerminalWsGateway(stubContext(), manager)
  // Route the gateway at the fake webServer exactly like the service does.
  web.registerUpgrade({
    path: '/plugins/dsh-terminal/ws',
    handler: (req, socket, head) => {
      gateway.handleUpgradeRequest(web.host, req, socket, head)
    },
  })
  return { web, manager, subprocess }
}

const opened = new Set<{ server: Server; manager: PtySessionManager }>()

afterEach(async () => {
  for (const item of opened) {
    await item.manager.disposeAll()
    await new Promise<void>(resolve => item.server.close(() => { resolve() }))
  }
  opened.clear()
})

interface ClientCollector {
  ws: WebSocket
  text: string[]
  bytes: string
  closed: { code: number; reason: string } | null
}

function connect(web: FakeWebServer, origin: string): Promise<ClientCollector> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${web.port}/plugins/dsh-terminal/ws`, {
      headers: { origin },
    })
    const collector: ClientCollector = { ws, text: [], bytes: '', closed: null }
    ws.on('open', () => { resolve(collector) })
    ws.on('error', reject)
    ws.on('message', (data, isBinary) => {
      if (isBinary) collector.bytes += data.toString('utf8')
      else collector.text.push(data.toString('utf8'))
    })
    ws.on('close', (code, reason) => {
      collector.closed = { code, reason: reason.toString() }
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('TerminalWsGateway (real sockets)', () => {
  it('proxies a full session: attach, live output, stdin, exit', async () => {
    const harness = await boot()
    opened.add({ server: harness.web.server, manager: harness.manager })
    const { agent } = fakeAgent()
    const session = await harness.manager.spawn(agent, 'tab1')
    const handle = harness.subprocess.handles[0] as FakeHandle

    const client = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    client.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))

    await wait(50)
    handle.output.write('welcome\r\n')
    await wait(50)
    client.ws.send(Buffer.from('ls -la\r', 'utf8'))
    await wait(50)
    handle.doneResolvers.resolve({ exitCode: 0 })
    await wait(50)

    const attached = client.text.map(text => JSON.parse(text) as { type: string }).find(f => f.type === 'attached')
    expect(attached).toBeDefined()
    expect(client.bytes).toBe('welcome\r\n')
    expect(handle.writes).toEqual(['ls -la\r'])
    expect(client.text.map(text => JSON.parse(text) as { type: string })).toContainEqual({ type: 'exit', exitCode: 0 })
    client.ws.close()
  })

  it('replays ring bytes before live output on a fresh attach', async () => {
    const harness = await boot()
    opened.add({ server: harness.web.server, manager: harness.manager })
    const { agent } = fakeAgent()
    const session = await harness.manager.spawn(agent, 'tab1')
    const handle = harness.subprocess.handles[0] as FakeHandle

    // First client warms the ring, then detaches (page refresh shape).
    const first = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    first.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))
    await wait(50)
    handle.output.write('history-1 ')
    handle.output.write('history-2')
    await wait(50)
    first.ws.close()
    await wait(50)

    const second = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    second.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))
    await wait(50)
    handle.output.write(' live-tail')
    await wait(50)

    expect(second.bytes).toBe('history-1 history-2 live-tail')
    second.ws.close()
  })

  it('rejects cross-origin upgrades at the handshake', async () => {
    const harness = await boot()
    opened.add({ server: harness.web.server, manager: harness.manager })
    const { agent } = fakeAgent()
    await harness.manager.spawn(agent, 'tab1')

    await expect(connect(harness.web, 'http://evil.example')).rejects.toThrow()
    await wait(50)
  })

  it('answers resize with RESIZE_UNSUPPORTED and rejects duplicate attach', async () => {
    const harness = await boot()
    opened.add({ server: harness.web.server, manager: harness.manager })
    const { agent } = fakeAgent()
    const session = await harness.manager.spawn(agent, 'tab1')

    const client = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    client.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))
    await wait(50)
    client.ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 30 }))
    await wait(50)
    const frames = client.text.map(text => JSON.parse(text) as { type: string; code?: string })
    expect(frames).toContainEqual({ type: 'error', code: 'RESIZE_UNSUPPORTED', message: expect.any(String) })
    expect(client.closed).toBeNull()

    // A second attach on the same connection is a protocol violation (1002).
    client.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))
    await wait(50)
    expect(client.closed).toMatchObject({ code: 1002, reason: 'already attached' })
  })

  it('rejects a second connection on an occupied tab with TAB_ALREADY_ATTACHED', async () => {
    const harness = await boot()
    opened.add({ server: harness.web.server, manager: harness.manager })
    const { agent } = fakeAgent()
    const session = await harness.manager.spawn(agent, 'tab1')

    const first = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    first.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))
    await wait(50)

    const second = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    second.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: session.tabId, replay: true }))
    await wait(50)

    const frames = second.text.map(text => JSON.parse(text) as { type: string; code?: string })
    expect(frames).toContainEqual({ type: 'error', code: 'TAB_ALREADY_ATTACHED', message: expect.any(String) })
    expect(second.closed).toMatchObject({ code: 1011, reason: 'TAB_ALREADY_ATTACHED' })
    first.ws.close()
  })

  it('closes with 1011 TAB_NOT_FOUND for unknown tabs of a known session', async () => {
    const harness = await boot()
    opened.add({ server: harness.web.server, manager: harness.manager })
    const { agent } = fakeAgent()
    await harness.manager.spawn(agent, 'tab1')

    const client = await connect(harness.web, `http://127.0.0.1:${harness.web.port}`)
    client.ws.send(JSON.stringify({ type: 'attach', sessionId: 'sess-1', tabId: 'ghost', replay: true }))
    await wait(50)

    expect(client.closed).toMatchObject({ code: 1011, reason: 'TAB_NOT_FOUND' })
  })
})
