> 🌐 Language: **English** | [中文](README.md)

# dsh-terminal

Embeds a **collapsible interactive terminal** inside DeepSeek Harness Web conversations: each tab is a live PTY shell running on your machine (host), rendered as a real terminal in the browser via xterm.js.

## Preview

**Expanded** — multiple terminal tabs, quick-command chips, settings and pin buttons:

![dsh-terminal expanded](docs/expanded.png)

**Collapsed** — a compact title bar:

![dsh-terminal collapsed](docs/collapsed.png)

## Features

- **Real terminal**: a live shell in each tab; full-screen apps like `vim` / `less` work fine.
- **Familiar keys**: Ctrl-C / Ctrl-D / Ctrl-Z behave like your local terminal.
- **Auto-reconnect**: recovers from page refreshes and network hiccups, replaying recent output.
- **Quick commands**: one-click chips run frequent commands; the ⚙ dialog manages them (aliases included).
- **Pin**: keep the panel open, or let it auto-collapse when you click outside.
- **Multi-tab**: open, close, and restart shells; an `exit N` bar lets you reopen a finished shell.
- **Invisible to the agent**: your terminal activity stays out of the chat.
- **Bilingual & theme-aware**: UI in English and Chinese; colors follow the web theme.

## Installation

```bash
pnpm dsh plugin --profile web add @geebos/dsh-terminal
# or
npm dsh plugin --profile web add @geebos/dsh-terminal
```

After installing, restart `dsh web`; the terminal title bar appears above the conversation input box.

## Usage

- Click the title bar to expand the terminal; `+` creates a tab, `×` closes one, ■ ends the current tab's shell.
- The chips in the expanded title bar are quick commands — click to inject into the current tab; ⚙ manages commands and aliases.
- The pin button controls pinning: when pinned, clicking outside the card no longer collapses it.
- After a page refresh or network hiccup it auto-reconnects and replays recent output; after a host restart you need to create a new tab.

## Architecture

```
Browser                                    host (dsh web = your machine)
┌────────────────────────────┐             ┌──────────────────────────────────────────┐
│ Terminal component (React) │control RPC  │ TerminalService (TypertRemoteService)    │
│ tabs / chips / pin / gear  │────────────→│ list / save / createTab / closeTab       │
│ xterm.js × N (one/tab)     │             │ signalTab (agent-scoped)                 │
│ PtyConnection × N          │←═══════════→│         │ spawn/kill                     │
└────────────────────────────┘data WS      │         ↓                                │
                              (binary)     │ PtySessionManager (ring/backpressure)    │
                                           │   │ subprocess.spawnTerminal()           │
                                           │   ↓                                      │
                                           │ node-pty → sh -c 'TERM=…; exec … -i'     │
                                           └──────────────────────────────────────────┘
```

- **Control plane** (Typert, unary JSON RPC): tab metadata and quick commands; requires `agent` context (session cwd, sandbox policy, lifecycle hooks).
- **Data plane** (plugin-private WebSocket `ws(s)://<origin>/plugins/dsh-terminal/ws`): text frames are JSON control frames (`attach`/`attached`/`exit`/`error`/`signal`/`resize`), binary frames are raw terminal bytes; one connection per tab.
- **Trust fence**: the upgrade handshake requires the Origin to match the Host origin and the Host to be loopback or the webserver bind address; the attach `(sessionId, tabId)` must hit the registry, with at most one observer connection per tab.
- **Lifecycle**: destroying a dsh session tears down all of its PTYs; all are terminated on host exit; after a PTY exits naturally the tab is kept (the ring buffer is still replayable).
- **Backpressure**: any socket send queue above 1 MiB pauses PTY output, below 256 KiB resumes; above 8 MiB the slow consumer is dropped (the client reconnects and recovers from the ring).

## Sandbox

- The interactive terminal is **not confined by the session sandbox by default**: terminal input comes entirely from the user's keyboard (loopback page), while the session sandbox's job is to constrain model-initiated actions — confining the user's own interactive shell with it would reject much of zsh initialization (history locks, completion cache, theme output) and be basically unusable.
- To align with session-sandbox semantics, start `dsh web` with `DSH_TERMINAL_SANDBOX=1`: the PTY is wrapped via `sandbox.confine` at spawn time according to the session mode; switching mode while running does not affect existing PTYs.
- The unsandboxed exposure surface is the same as VS Code's integrated terminal, ttyd, and other local web terminals; the entry is gated by the WS trust fence. Only darwin / linux are supported (Windows ConPTY unverified).

## Known limitations

1. Fixed 100×24: horizontal scrolling on narrow panels, until upstream provides `handle.resize()` (the protocol frame is already reserved).
2. Host restart = all PTYs terminated, no process-level recovery.
3. One WS connection per tab; multiple browser tabs observing the same tab are rejected.
4. Prompt icons (Powerlevel10k, etc.) depend on a locally installed Nerd Font (recommended `MesloLGS NF`); without one, icons render as boxes.

## Development

```bash
# Build
pnpm --filter dsh-terminal build

# Test (RingBuffer, frame codec, trust fence, PtySessionManager lifecycle/backpressure, WS gateway integration)
pnpm --filter dsh-terminal test

# Hot reload: watching this repo rebuilds lib/*.js from src/ (host-half changes need a dsh web restart)
cd dsh-terminal && npm run dev
```

Dependency notes: `@xterm/xterm` and `@xterm/addon-web-links` are inlined into `lib/client.js`, `ws` into `lib/index.js` (all devDependencies); after upgrading `@xterm/xterm`, run `npm run embed:css` to regenerate the embedded styles.

## Friends

- [LINUX DO](https://linux.do/) — Where possible begins
