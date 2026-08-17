/**
 * The terminal UI: a collapsible dock above the composer where every tab is
 * one live host PTY rendered by xterm.js. Terminal bytes flow over the
 * plugin's private WebSocket (PtyConnection); the Typert control plane is
 * used only for tab metadata and quick commands. Tabs keep their xterm
 * instance and connection while hidden so scrollback stays fresh; the PTY
 * geometry is fixed at 100×24 (upstream has no resize API yet).
 */

import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Terminal as XTerm, type ITheme } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import {
  Button,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSettingsOutline16,
  IconStopFill16,
  IconTrashOutline16,
  Input,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TerminalCloseTabValue,
  TerminalCommand,
  TerminalCreateTabValue,
  TerminalListValue,
  TerminalSaveValue,
  TerminalSignal,
  TerminalSignalValue,
  TerminalTabInfo,
} from '../types.ts'
import { PtyConnection, type PtyConnDetail, type PtyConnState } from './pty-connection.ts'
import { XTERM_CSS } from './xterm-css.ts'

/** Fixed PTY geometry shared with the host spawn (D1). */
const TERM_COLS = 100
const TERM_ROWS = 24
const TERM_FONT_SIZE = 12
const TERM_LINE_HEIGHT = 1.25

/** Component props: standard `sessionId` plus the inject face and locale `t`. */
interface TerminalProps extends PropsLocale<'dsh-terminal'> {
  sessionId: string
  listState: () => Promise<TerminalListValue>
  saveCommands: (commands: TerminalCommand[]) => Promise<TerminalSaveValue>
  createTab: () => Promise<TerminalCreateTabValue>
  closeTab: (tabId: string) => Promise<TerminalCloseTabValue>
  signalTab: (tabId: string, signal: TerminalSignal) => Promise<TerminalSignalValue>
}

/** localStorage slot for the pin preference ('1' = pinned); browser-local, no host round-trip. */
const PINNED_STORAGE_KEY = 'dsh-terminal:pinned'

function readStoredPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeStoredPinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, pinned ? '1' : '0')
  } catch {
    // Unavailable storage (private mode & co.) just means the preference
    // won't survive a reload; the in-memory state still drives the panel.
  }
}

/** Client-side tab: server metadata plus the live connection state. */
interface ClientTab {
  id: string
  name: string
  status: TerminalTabInfo['status']
  exitCode: number | null
  connState: PtyConnState
}

/** Non-React per-tab runtime: one xterm instance and one data-plane connection. */
interface TabRuntime {
  conn: PtyConnection
  term: XTerm
  el: HTMLDivElement | null
}

function toClientTab(tab: TerminalTabInfo): ClientTab {
  return {
    id: tab.id,
    name: tab.name,
    status: tab.status,
    exitCode: tab.exitCode,
    connState: tab.status === 'exited' ? 'exited' : 'connecting',
  }
}

function makeId(): string {
  return 'qc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

type ColorScheme = 'light' | 'dark'

/** The presenter marks the active palette with this body attribute. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

function activeColorScheme(): ColorScheme {
  return document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light'
}

/**
 * Read one design token. Tokens live on `body` (and `body[data-ds-dark-theme]`
 * for the dark palette), so body is the only correct computed-style source.
 */
function bodyToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value !== '' ? value : fallback
}

/**
 * Curated violet/teal fills for the two ANSI families the design platform has
 * no static scale for; its statics are tailwind-derived, so these hues match
 * the palette's lightness envelope.
 */
const CURATED = {
  light: { magenta: '#9333ea', brightMagenta: '#a855f7', cyan: '#0d9488', brightCyan: '#14b8a6' },
  dark: { magenta: '#c084fc', brightMagenta: '#d8b4fe', cyan: '#2dd4bf', brightCyan: '#5eead4' },
} as const

/** ANSI 0–15 mapped onto the design platform scales, stepped per scheme. */
function ansiPalette(scheme: ColorScheme): Partial<ITheme> {
  if (scheme === 'dark') {
    return {
      black: bodyToken('--dsw-static-neutral-bluish-950', '#151517'),
      red: bodyToken('--dsw-static-red-400', '#f25a5a'),
      green: bodyToken('--dsw-static-green-400', '#4ed17e'),
      yellow: bodyToken('--dsw-static-amber-400', '#f7ad31'),
      blue: bodyToken('--dsw-static-blue-300', '#93c5fd'),
      magenta: CURATED.dark.magenta,
      cyan: CURATED.dark.cyan,
      white: bodyToken('--dsw-static-neutral-bluish-200', '#e1e5ee'),
      brightBlack: bodyToken('--dsw-static-neutral-bluish-600', '#81858c'),
      brightRed: bodyToken('--dsw-static-red-500', '#ef4444'),
      brightGreen: bodyToken('--dsw-static-green-400', '#4ed17e'),
      brightYellow: bodyToken('--dsw-static-amber-400', '#f7ad31'),
      brightBlue: bodyToken('--dsw-static-blue-300', '#93c5fd'),
      brightMagenta: CURATED.dark.brightMagenta,
      brightCyan: CURATED.dark.brightCyan,
      brightWhite: bodyToken('--dsw-static-neutral-bluish-50', '#f9fafb'),
    }
  }
  return {
    black: bodyToken('--dsw-static-neutral-bluish-900', '#1b1b1c'),
    red: bodyToken('--dsw-static-red-600', '#ec1313'),
    green: bodyToken('--dsw-static-green-500', '#22c55e'),
    yellow: bodyToken('--dsw-static-amber-600', '#dd8629'),
    blue: bodyToken('--dsw-static-blue-600', '#2563eb'),
    magenta: CURATED.light.magenta,
    cyan: CURATED.light.cyan,
    white: bodyToken('--dsw-static-neutral-bluish-50', '#f9fafb'),
    brightBlack: bodyToken('--dsw-static-neutral-bluish-500', '#979da6'),
    brightRed: bodyToken('--dsw-static-red-500', '#ef4444'),
    brightGreen: bodyToken('--dsw-static-green-400', '#4ed17e'),
    brightYellow: bodyToken('--dsw-static-amber-500', '#f59e0b'),
    brightBlue: bodyToken('--dsw-static-blue-500', '#3b82f6'),
    brightMagenta: CURATED.light.brightMagenta,
    brightCyan: CURATED.light.brightCyan,
    brightWhite: bodyToken('--dsw-static-neutral-bluish-00', '#ffffff'),
  }
}

/** Full xterm theme for the currently active app scheme. */
function buildTermTheme(): { theme: ITheme; background: string } {
  const dark = activeColorScheme() === 'dark'
  const background = bodyToken('--dsw-alias-bg-layer-2', dark ? '#2c2c2e' : '#ffffff')
  const theme: ITheme = {
    background,
    foreground: bodyToken('--dsw-alias-label-primary', dark ? '#f9fafb' : '#0f1115'),
    cursor: bodyToken('--dsw-alias-state-business-primary', dark ? '#679efe' : '#4176e6'),
    cursorAccent: background,
    selectionBackground: dark ? '#314e78' : 'rgba(65, 118, 230, 0.22)',
    ...ansiPalette(activeColorScheme()),
  }
  return { theme, background }
}

/**
 * Nerd Fonts lead the stack so prompt themes (Powerlevel10k and friends)
 * render their icon glyphs; when one is installed it also becomes the
 * primary face, keeping cell metrics consistent across text and icons.
 * Without any Nerd Font the system monospaces take over (icons show tofu).
 */
const TERM_FONT_FAMILY = [
  'MesloLGS NF',
  'JetBrainsMono Nerd Font',
  'JetBrainsMono Nerd Font Mono',
  'FiraCode Nerd Font',
  'Hack Nerd Font',
  'SauceCodePro Nerd Font',
  'Symbols Nerd Font Mono',
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  'monospace',
].map(name => `"${name}"`).join(', ')

/**
 * Read back the height xterm actually rendered for the fixed rows×cell
 * metrics (the `.xterm-screen` element carries explicit pixel dimensions
 * after open), so the pane stack sizes to the real terminal instead of a
 * font-metric guess that clips the last row.
 */
function measureTerminalHeight(el: HTMLElement): number | null {
  const screen = el.querySelector('.xterm-screen')
  if (screen === null) return null
  const height = screen.getBoundingClientRect().height
  return Number.isFinite(height) && height > 0 ? height : null
}

function createTerminal(el: HTMLDivElement): { term: XTerm; height: number | null } {
  const { theme, background } = buildTermTheme()
  const term = new XTerm({
    cols: TERM_COLS,
    rows: TERM_ROWS,
    scrollback: 5000,
    fontSize: TERM_FONT_SIZE,
    lineHeight: TERM_LINE_HEIGHT,
    cursorBlink: true,
    fontFamily: TERM_FONT_FAMILY,
    theme,
  })
  term.loadAddon(new WebLinksAddon())
  term.open(el)
  // xterm's stylesheet hardcodes the viewport background to #000; track the
  // themed background so the scrollbar lane matches the pane.
  el.style.setProperty('--qc-term-bg', background)
  return { term, height: measureTerminalHeight(el) }
}

/** Re-apply the current app theme to one live terminal (scrollback is kept). */
function applyTerminalTheme(entry: { term: XTerm; el: HTMLDivElement | null }): void {
  const { theme, background } = buildTermTheme()
  entry.term.options.theme = theme
  entry.el?.style.setProperty('--qc-term-bg', background)
}

/**
 * The xterm mount point, isolated in its own memoized component so the pane's
 * ref callback keeps a stable identity across parent re-renders. An inline
 * ref in the parent would be detached/reattached on every setTabs render,
 * destroying and recreating the live terminal and connection each cycle.
 */
const XtermMount = memo(function XtermMount(props: {
  tabId: string
  attach: (tabId: string, el: HTMLDivElement | null) => void
}): ReactElement {
  const ref = useCallback((el: HTMLDivElement | null): void => {
    props.attach(props.tabId, el)
  }, [props.attach, props.tabId])
  return createElement('div', { className: 'qc-term-xterm', ref })
})

/**
 * Pushpin glyph for the pin toggle. The primitives library ships no pin icon,
 * so this follows its icon anatomy (currentColor, sized via prop); the
 * unpinned state renders the pin slanted, the pinned state upright.
 */
function PinIcon(props: { size?: number; slanted?: boolean }): ReactElement {
  const style: CSSProperties | undefined = props.slanted === true ? { transform: 'rotate(45deg)' } : undefined
  return createElement('svg', {
    width: props.size ?? 16,
    height: props.size ?? 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style,
  },
  createElement('path', { d: 'M12 17v5' }),
  createElement('path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z' }))
}

function Terminal(props: TerminalProps): ReactElement {
  const sessionId = props.sessionId
  const t = props.t

  const [commands, setCommands] = useState<TerminalCommand[]>([])
  const [tabs, setTabs] = useState<ClientTab[]>([])
  const [activeTabId, setActiveTabId] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(readStoredPinned)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<TerminalCommand[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  /** Measured pixel height of the fixed 24-row viewport (first terminal wins). */
  const [termHeight, setTermHeight] = useState<number | null>(null)

  const runtimes = useRef(new Map<string, TabRuntime>())
  const tabsRef = useRef<ClientTab[]>([])
  useEffect(() => { tabsRef.current = tabs }, [tabs])
  /** Quick-command payloads queued for a freshly created tab until it streams. */
  const pendingCommands = useRef(new Map<string, string>())
  /** The terminal card element; outside-click detection tests containment against it. */
  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRoot = useCallback((el: HTMLDivElement | null): void => { rootRef.current = el }, [])

  const validSession = typeof sessionId === 'string' && sessionId !== ''

  useEffect(() => {
    let cancelled = false
    if (!validSession) {
      disposeAllRuntimes(runtimes.current)
      setTabs([])
      setActiveTabId('')
      return undefined
    }
    props.listState().then((res) => {
      if (cancelled) return
      setCommands(Array.isArray(res.commands) ? res.commands : [])
      const next = Array.isArray(res.tabs) ? res.tabs.map(toClientTab) : []
      for (const id of [...runtimes.current.keys()]) {
        if (!next.some((tab) => tab.id === id)) disposeRuntime(runtimes.current, id)
      }
      setTabs(next)
      setActiveTabId(next[0]?.id ?? '')
      setNotice(res.warning ?? null)
    }, (err: unknown) => {
      if (cancelled) return
      setNotice(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [sessionId])

  // Focus the active terminal whenever the panel expands or the tab switches.
  useEffect(() => {
    if (!expanded) return
    const entry = runtimes.current.get(activeTabId)
    if (entry !== undefined) entry.term.focus()
  }, [expanded, activeTabId])

  // Unpinned panels yield to anywhere else in the app: a pointerdown outside
  // the terminal card collapses it, while a pinned panel only folds via the
  // collapse button. The settings modal portals to <body>, so while it is
  // open those clicks are treated as inside. Capture phase keeps detection
  // working even when inner handlers swallow the event.
  useEffect(() => {
    if (!expanded || pinned) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (settingsOpen) return
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setExpanded(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [expanded, pinned, settingsOpen])

  // Follow app theme switches live: the presenter lands token variables and
  // the dark attribute on <body>, so watching those attributes sees the final
  // state regardless of listener ordering; rAF coalesces the burst.
  useEffect(() => {
    let raf = 0
    const apply = (): void => {
      raf = 0
      for (const entry of runtimes.current.values()) applyTerminalTheme(entry)
    }
    const observer = new MutationObserver(() => {
      if (raf === 0) raf = requestAnimationFrame(apply)
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', DARK_ATTRIBUTE] })
    return () => {
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => () => { disposeAllRuntimes(runtimes.current) }, [])

  const handleConnState = useCallback((tabId: string, state: PtyConnState, detail?: PtyConnDetail): void => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.id !== tabId) return tab
      const next: ClientTab = { ...tab, connState: state }
      if (state === 'exited') {
        next.status = 'exited'
        next.exitCode = detail?.exitCode ?? null
      }
      if (state === 'streaming' && detail?.status === 'exited') {
        next.status = 'exited'
        next.exitCode = detail.exitCode ?? null
      }
      return next
    }))
  }, [])

  const attachContainer = useCallback((tabId: string, el: HTMLDivElement | null): void => {
    if (el === null) {
      disposeRuntime(runtimes.current, tabId)
      return
    }
    const existing = runtimes.current.get(tabId)
    if (existing !== undefined) {
      existing.el = el
      return
    }
    if (!validSession) return
    const { term, height } = createTerminal(el)
    if (height !== null) setTermHeight(prev => prev ?? height)
    let runtime: TabRuntime
    const conn = new PtyConnection(sessionId, tabId, TERM_COLS, TERM_ROWS, {
      // Guarded against a disposed runtime so a queued event can never
      // write into a torn-down terminal.
      onData: (text) => { if (runtimes.current.get(tabId) === runtime) term.write(text) },
      onState: (state, detail) => {
        if (runtimes.current.get(tabId) !== runtime) return
        // Fresh attach: the replay that follows rebuilds the viewport.
        if (state === 'streaming') {
          term.reset()
          const command = pendingCommands.current.get(tabId)
          if (command !== undefined) {
            pendingCommands.current.delete(tabId)
            conn.send(command + '\r')
          }
        }
        handleConnState(tabId, state, detail)
      },
    })
    runtime = { conn, term, el }
    term.onData((data) => { conn.send(data) })
    runtimes.current.set(tabId, runtime)
    conn.open()
  }, [sessionId, validSession, handleConnState])

  function persist(next: TerminalCommand[]): void {
    setCommands(next)
    if (!validSession) return
    props.saveCommands(next).then((res) => {
      setNotice(res.warning ?? null)
    }, (err: unknown) => {
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }

  /** Flip the pin preference and persist it to browser localStorage. */
  function togglePinned(): void {
    const next = !pinned
    setPinned(next)
    writeStoredPinned(next)
  }

  function sanitize(list: TerminalCommand[]): TerminalCommand[] {
    const out: TerminalCommand[] = []
    for (const c of list) {
      const command = (c.command || '').trim()
      if (command === '') continue
      const alias = (c.alias || '').trim() || command
      out.push({ id: c.id, alias, command })
    }
    return out
  }

  function addTabFromResponse(res: TerminalCreateTabValue): void {
    const tab = toClientTab(res.tab)
    setTabs((prev) => prev.concat([tab]))
    setActiveTabId(tab.id)
    if (res.warning !== undefined) setNotice(res.warning)
  }

  function newTab(): void {
    if (!validSession) return
    setExpanded(true)
    props.createTab().then(addTabFromResponse, (err: unknown) => {
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }

  function closeTab(tabId: string): void {
    if (!validSession) return
    props.closeTab(tabId).then((res) => {
      disposeRuntime(runtimes.current, tabId)
      setTabs((prev) => prev.filter((tab) => tab.id !== tabId))
      if (activeTabId === tabId) {
        const fallback = tabsRef.current.find((tab) => tab.id !== tabId)
        setActiveTabId(fallback?.id ?? '')
      }
      setNotice(res.warning ?? null)
    }, (err: unknown) => {
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }

  function reopenTab(tabId: string): void {
    if (!validSession) return
    props.closeTab(tabId).then(() => {
      disposeRuntime(runtimes.current, tabId)
      setTabs((prev) => prev.filter((tab) => tab.id !== tabId))
      return props.createTab()
    }).then(addTabFromResponse, (err: unknown) => {
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }

  function killActiveTab(): void {
    const entry = runtimes.current.get(activeTabId)
    if (entry === undefined) return
    entry.conn.signal('SIGTERM')
    entry.term.focus()
  }

  function runChip(command: string): void {
    if (!validSession) return
    setExpanded(true)
    const tab = tabs.find((item) => item.id === activeTabId)
    const entry = runtimes.current.get(activeTabId)
    // A terminal is usable only when its shell is alive and its data plane is
    // streaming; connecting/reconnecting (blocked) and exited/dead tabs drop
    // input, so they must not be reused.
    const usable = tab !== undefined && tab.status === 'alive'
      && entry !== undefined && entry.conn.currentState === 'streaming'
    if (usable) {
      entry.conn.send(command + '\r')
      entry.term.focus()
      return
    }
    props.createTab().then((res) => {
      pendingCommands.current.set(res.tab.id, command)
      addTabFromResponse(res)
    }, (err: unknown) => {
      setNotice(err instanceof Error ? err.message : String(err))
    })
  }

  function updateRow(id: string, field: 'alias' | 'command', value: string): void {
    setDraft((prev) => prev.map((c) => {
      if (c.id !== id) return c
      if (field === 'alias') return { id: c.id, alias: value, command: c.command }
      return { id: c.id, alias: c.alias, command: value }
    }))
  }

  function addRow(): void {
    setDraft((prev) => prev.concat([{ id: makeId(), alias: '', command: '' }]))
  }

  function removeRow(id: string): void {
    setDraft((prev) => prev.filter((c) => c.id !== id))
  }

  function openSettings(): void {
    setDraft(commands.map((c) => ({ id: c.id, alias: c.alias, command: c.command })))
    setSettingsOpen(true)
  }

  function saveSettings(): void {
    persist(sanitize(draft))
    setSettingsOpen(false)
  }

  function cancelSettings(): void {
    setSettingsOpen(false)
  }

  function toggleSettings(): void {
    if (settingsOpen) cancelSettings()
    else openSettings()
  }

  const toggleIcon = expanded ? createElement(IconChevronDownOutline14) : createElement(IconChevronRightOutline14)

  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  /** Live PTY count shown in the collapsed header while tabs are hidden. */
  const runningTabCount = tabs.reduce((n, tab) => (tab.status === 'alive' ? n + 1 : n), 0)

  const chipsChildren: ReactNode[] = []
  for (const c of commands) {
    chipsChildren.push(createElement(Pill, {
      key: c.id,
      onClick: () => runChip(c.command),
      title: c.command,
    }, c.alias))
  }

  const tabChildren: ReactNode[] = []
  tabs.forEach((tab) => {
    const isActive = tab.id === activeTabId
    const wrapChildren: ReactNode[] = [
      createElement('button', {
        key: 'tab',
        type: 'button',
        className: 'qc-tab',
        onClick: () => setActiveTabId(tab.id),
        title: tab.name,
        'aria-label': tab.name,
      }, createElement('span', { className: 'qc-tab-label' }, tab.name)),
    ]
    wrapChildren.push(createElement('button', {
      key: 'close',
      type: 'button',
      className: 'qc-tab-close',
      onClick: () => closeTab(tab.id),
      title: t('terminal.closeTab'),
      'aria-label': t('terminal.closeTab'),
    }, createElement(IconCloseOutline16, { size: 12 })))
    tabChildren.push(createElement('div', {
      key: tab.id,
      className: 'qc-tab-wrap' + (isActive ? ' qc-tab-wrap-active' : ''),
    }, wrapChildren))
  })
  tabChildren.push(createElement('button', {
    key: 'new-tab',
    type: 'button',
    className: 'qc-tab-add',
    onClick: newTab,
    'aria-label': t('terminal.newTab'),
    title: t('terminal.newTab'),
  }, createElement(IconPlusOutline16, { size: 12 })))
  if (activeTab !== undefined && activeTab.status === 'alive') {
    tabChildren.push(createElement('button', {
      key: 'kill',
      type: 'button',
      className: 'qc-tab-kill',
      onClick: killActiveTab,
      'aria-label': t('terminal.kill'),
      title: t('terminal.kill'),
    }, createElement(IconStopFill16, { size: 13 })))
  }

  const headActions: ReactNode[] = []
  if (expanded) {
    const pinLabel = pinned ? t('terminal.unpin') : t('terminal.pin')
    headActions.push(createElement(Button, {
      variant: 'ghost',
      size: 'sm',
      className: 'qc-icon-btn',
      icon: createElement(PinIcon, { slanted: !pinned }),
      onClick: togglePinned,
      'aria-label': pinLabel,
      'aria-pressed': pinned,
      title: pinLabel,
    }))
  }
  headActions.push(createElement(Button, { variant: 'ghost', size: 'sm', className: 'qc-icon-btn', icon: createElement(IconSettingsOutline16), onClick: toggleSettings, 'aria-label': t('terminal.settings'), title: t('terminal.settings') }))

  const head = createElement('div', { className: 'qc-head' },
    createElement('div', { className: 'qc-head-left' },
      createElement(Button, { variant: 'ghost', size: 'sm', className: 'qc-icon-btn', icon: toggleIcon, onClick: () => setExpanded(!expanded), 'aria-label': expanded ? t('terminal.collapse') : t('terminal.expand') }),
      createElement('span', { className: 'qc-title' }, t('terminal.title')),
      !expanded && runningTabCount > 0
        ? createElement('span', { className: 'qc-tab-count' }, t('terminal.tabsCount', { count: String(runningTabCount) }))
        : null,
    ),
    createElement('div', { className: 'qc-chips' }, chipsChildren),
    ...headActions,
  )

  const bodyChildren: ReactNode[] = [
    createElement('div', { key: 'tabs', className: 'qc-tabs' }, tabChildren),
  ]
  if (notice !== null) {
    bodyChildren.push(createElement('div', { key: 'notice', className: 'qc-body-notice' }, notice))
  }

  const paneChildren: ReactNode[] = []
  for (const tab of tabs) {
    const isActive = tab.id === activeTabId
    const paneParts: ReactNode[] = [
      createElement(XtermMount, { key: 'xterm', tabId: tab.id, attach: attachContainer }),
    ]
    if (tab.connState === 'connecting' || tab.connState === 'reconnecting') {
      paneParts.push(createElement('div', { key: 'banner', className: 'qc-term-banner' },
        tab.connState === 'reconnecting' ? t('terminal.reconnecting') : t('terminal.connecting')))
    }
    if (tab.connState === 'dead') {
      paneParts.push(createElement('div', { key: 'dead', className: 'qc-term-dead' }, t('terminal.dead')))
    }
    if (tab.status === 'exited') {
      paneParts.push(createElement('div', { key: 'exited', className: 'qc-term-exited' },
        createElement('span', { className: 'qc-term-exited-text' },
          `${t('terminal.exited')}${tab.exitCode === null ? '' : ` (exit ${tab.exitCode})`}`),
        createElement(Button, {
          variant: 'outline',
          size: 'sm',
          className: 'qc-term-reopen',
          icon: createElement(IconRefreshOutline16, { size: 13 }),
          onClick: () => reopenTab(tab.id),
        }, t('terminal.reopen')),
      ))
    }
    paneChildren.push(createElement('div', {
      key: tab.id,
      className: 'qc-term-pane' + (isActive ? '' : ' qc-term-pane-hidden'),
    }, paneParts))
  }

  if (tabs.length === 0) {
    paneChildren.push(createElement('div', { key: 'empty', className: 'qc-term-empty' },
      createElement('div', { className: 'qc-term-empty-hint' }, t('terminal.emptyHint')),
      createElement(Button, {
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconPlusOutline16),
        onClick: newTab,
      }, t('terminal.openFirst')),
    ))
  }

  const stackStyle: CSSProperties | undefined = termHeight === null
    ? undefined
    : ({ '--qc-term-h': `${termHeight}px` }) as CSSProperties
  bodyChildren.push(createElement('div', {
    key: 'stack',
    className: 'qc-term-stack',
    style: stackStyle,
    onMouseDown: () => {
      const entry = runtimes.current.get(activeTabId)
      if (entry !== undefined) entry.term.focus()
    },
  }, paneChildren))

  const body = expanded ? createElement('div', { className: 'qc-body' }, bodyChildren) : null

  const modalChildren: ReactNode[] = []
  const listChildren: ReactNode[] = []
  if (draft.length === 0) {
    listChildren.push(createElement('div', { key: 'empty', className: 'qc-status' }, t('settings.empty')))
  } else {
    for (const c of draft) {
      listChildren.push(createElement('div', { key: c.id, className: 'qc-modal-row' },
        createElement(Input, {
          className: 'qc-modal-alias',
          placeholder: t('settings.alias'),
          value: c.alias || '',
          onChange: (e: { target: { value: string } }) => updateRow(c.id, 'alias', e.target.value),
        }),
        createElement(Input, {
          className: 'qc-modal-cmd',
          placeholder: t('settings.command'),
          value: c.command || '',
          onChange: (e: { target: { value: string } }) => updateRow(c.id, 'command', e.target.value),
        }),
        createElement(Button, { variant: 'ghost', size: 'sm', className: 'qc-icon-btn', icon: createElement(IconTrashOutline16), onClick: () => removeRow(c.id), 'aria-label': t('settings.delete'), title: t('settings.delete') }),
      ))
    }
  }
  modalChildren.push(createElement('div', { key: 'list', className: 'qc-modal-list' }, listChildren))
  if (notice !== null) {
    modalChildren.push(createElement('div', { key: 'notice', className: 'qc-modal-notice' }, notice))
  }
  modalChildren.push(createElement(Button, { key: 'add', variant: 'outline', size: 'sm', className: 'qc-modal-add', icon: createElement(IconPlusOutline16), onClick: addRow }, t('settings.add')))

  const footer = createElement('div', { className: 'qc-modal-footer' },
    createElement(Button, { variant: 'outline', size: 'sm', onClick: cancelSettings }, t('settings.cancel')),
    createElement(Button, { variant: 'primary', size: 'sm', onClick: saveSettings }, t('settings.save')),
  )

  const modal = createElement(Modal, { open: settingsOpen, onClose: cancelSettings, title: t('settings.title'), closeLabel: t('settings.close'), className: 'qc-modal-dialog', footer }, modalChildren)

  return createElement('div', { className: 'qc-root', ref: setRoot }, head, body, modal)
}

function disposeRuntime(runtimes: Map<string, TabRuntime>, tabId: string): void {
  const entry = runtimes.get(tabId)
  if (entry === undefined) return
  runtimes.delete(tabId)
  entry.conn.close()
  entry.term.dispose()
}

function disposeAllRuntimes(runtimes: Map<string, TabRuntime>): void {
  for (const tabId of [...runtimes.keys()]) disposeRuntime(runtimes, tabId)
}

export default Terminal

const LOCAL_CSS = `.qc-root{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));max-width:var(--dsh-composer-card-max-width);margin:0 auto;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.qc-head{display:flex;align-items:center;gap:8px;padding:6px 8px}
.qc-head-left{display:flex;align-items:center;gap:6px;flex:none}
.qc-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.qc-tab-count{flex:none;font-size:11px;line-height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary)}
.qc-chips{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.qc-icon-btn{padding:0;width:28px;flex:none}
.qc-tabs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1)}
.qc-tab-wrap{display:flex;align-items:center;gap:2px;border-radius:6px 6px 0 0;padding:0 4px 0 8px;width:84px;height:32px;box-sizing:border-box;margin-bottom:-1px;transition:background .12s ease}
.qc-tab-wrap:hover:not(.qc-tab-wrap-active){background:var(--dsw-alias-interactive-bg-hover)}
.qc-tab-wrap-active{background:var(--dsw-alias-bg-layer-2);width:96px;box-shadow:inset 1px 0 0 var(--dsw-alias-border-l1),inset -1px 0 0 var(--dsw-alias-border-l1),inset 0 1px 0 var(--dsw-alias-border-l1),var(--dsw-shadow-lv1)}
.qc-tab{display:flex;align-items:center;justify-content:flex-start;flex:1;min-width:0;height:100%;padding:0;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.qc-tab-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.qc-tab-wrap-active .qc-tab-label{font-weight:600}
.qc-tab-close{display:flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;padding:0;border:none;border-radius:4px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.qc-tab-close:hover{color:var(--dsw-alias-label-primary)}
.qc-tab-add{display:flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;margin-bottom:-1px;padding:0;border:none;border-radius:6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.qc-tab-add:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.qc-tab-kill{display:flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;margin-bottom:-1px;margin-left:auto;padding:0;border:none;border-radius:6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.qc-tab-kill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.qc-body{display:flex;flex-direction:column;padding:0 8px 8px}
.qc-body-notice{margin:6px 0;font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.qc-term-stack{position:relative;height:calc(var(--qc-term-h,360px) + 12px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-top:none;border-radius:0 0 8px 8px;background:var(--qc-term-bg,var(--dsw-alias-bg-layer-2))}
.qc-term-pane{position:absolute;inset:0;padding:6px 4px 6px 8px;overflow-x:auto;overflow-y:hidden}
.qc-term-pane-hidden{visibility:hidden;pointer-events:none}
.qc-term-xterm{width:fit-content;margin-inline:auto}
.qc-term-xterm .xterm .xterm-viewport{background-color:var(--qc-term-bg,#000)}
.qc-term-xterm .xterm .composition-view{background-color:var(--qc-term-bg,#000)}
.qc-term-banner{position:absolute;top:0;left:0;right:0;z-index:10;padding:3px 10px;font-size:12px;color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1)}
.qc-term-dead{position:absolute;inset:0;z-index:11;display:flex;align-items:center;justify-content:center;padding:16px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.qc-term-exited{position:absolute;left:0;right:0;bottom:0;z-index:10;display:flex;align-items:center;gap:10px;padding:4px 10px;background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1)}
.qc-term-exited-text{flex:1;min-width:0;font-size:12px;font-style:italic;color:var(--dsw-alias-label-secondary)}
.qc-term-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.qc-term-empty-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.qc-modal-dialog{width:min(600px,100%)}
.qc-modal-list{display:flex;flex-direction:column;gap:6px}
.qc-modal-row{display:flex;align-items:center;gap:6px}
.qc-modal-alias{flex:none;width:96px}
.qc-modal-cmd{flex:1;min-width:0}
.qc-modal-notice{margin-top:8px;font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.qc-modal-add{margin-top:10px;width:100%}
.qc-modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}`

/** Combined stylesheet: vendored xterm structure plus this plugin's chrome. */
export const TERMINAL_CSS = `${XTERM_CSS}\n${LOCAL_CSS}`
