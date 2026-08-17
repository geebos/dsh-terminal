/** `dsh-terminal` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dsh-terminal'

/** English dictionary (the key-set source of truth). */
export const en = {
  'terminal.collapse': 'Collapse',
  'terminal.expand': 'Expand',
  'terminal.pin': 'Pin terminal (keep expanded)',
  'terminal.unpin': 'Unpin terminal (collapse on outside click)',
  'terminal.title': 'Terminal',
  'terminal.tabsCount': '{count} tabs',
  'terminal.settings': 'Quick command settings',
  'terminal.newTab': 'New tab',
  'terminal.closeTab': 'Close tab',
  'terminal.kill': 'Send SIGTERM to the active tab',
  'terminal.connecting': 'Connecting…',
  'terminal.reconnecting': 'Connection lost — reconnecting…',
  'terminal.dead': 'This terminal ended because the service restarted',
  'terminal.exited': 'Exited',
  'terminal.reopen': 'Reopen',
  'terminal.emptyHint': 'No terminal sessions yet — open one for an interactive shell',
  'terminal.openFirst': 'New terminal',
  'settings.title': 'Quick commands',
  'settings.empty': 'No quick commands yet',
  'settings.alias': 'Alias',
  'settings.command': 'Command',
  'settings.delete': 'Delete',
  'settings.add': 'Add',
  'settings.save': 'Save',
  'settings.cancel': 'Cancel',
  'settings.close': 'Close',
} satisfies Record<string, string>

/** Union of this namespace's dictionary keys. */
export type TerminalKey = keyof typeof en

/** Simplified Chinese dictionary. */
export const zh: Record<TerminalKey, string> = {
  'terminal.collapse': '收起',
  'terminal.expand': '展开',
  'terminal.pin': '固定终端（不自动收起）',
  'terminal.unpin': '取消固定（点击外部自动收起）',
  'terminal.title': '终端',
  'terminal.tabsCount': '{count} 个标签页',
  'terminal.settings': '快捷命令设置',
  'terminal.newTab': '新建标签页',
  'terminal.closeTab': '关闭标签页',
  'terminal.kill': '向当前标签页发送 SIGTERM',
  'terminal.connecting': '连接中…',
  'terminal.reconnecting': '连接已断开，正在重连…',
  'terminal.dead': '终端已随服务重启终止',
  'terminal.exited': '已退出',
  'terminal.reopen': '重开',
  'terminal.emptyHint': '暂无终端会话，新建一个即可获得交互式 shell',
  'terminal.openFirst': '新建终端',
  'settings.title': '快捷命令',
  'settings.empty': '暂无快捷命令',
  'settings.alias': '别名',
  'settings.command': '命令',
  'settings.delete': '删除',
  'settings.add': '添加',
  'settings.save': '保存',
  'settings.cancel': '取消',
  'settings.close': '关闭',
}
