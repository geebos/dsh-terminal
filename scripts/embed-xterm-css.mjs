/**
 * Regenerate src/client/xterm-css.ts from the installed @xterm/xterm CSS so
 * the plugin's single injected <style> block carries xterm's structural
 * styles. Run via `npm run build` (and after upgrading @xterm/xterm).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
if (css.includes('`') || css.includes('${')) {
  throw new Error('xterm.css now contains template-string metacharacters; escape them')
}
const version = JSON.parse(readFileSync(join(root, 'node_modules/@xterm/xterm/package.json'), 'utf8')).version
const out = `/**
 * Vendored structural stylesheet for xterm.js, inlined here because the
 * plugin's client bundle is a single injected <style> block with no asset
 * pipeline. Regenerate from node_modules when upgrading:
 *   node scripts/embed-xterm-css.mjs
 * Provenance: @xterm/xterm@${version} css/xterm.css (MIT).
 */

export const XTERM_CSS = \`${css}\`
`
writeFileSync(join(root, 'src/client/xterm-css.ts'), out)
console.log(`embedded ${css.length} chars of xterm.css (@xterm/xterm@${version})`)
