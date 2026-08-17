const PACKAGE_NAME = '@geebos/dsh-terminal'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
]
// Dev-side dependencies inlined into the single-file artifacts (no runtime
// install edges for the profile): xterm ships inside client.js, ws inside
// the host bundle.
const CLIENT_BUNDLED = ['zod', '@xterm/xterm', '@xterm/addon-web-links']

const config = [{
  name: PACKAGE_NAME,
  entry: ['src/index.ts', 'src/typert.host.ts', 'src/remote.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    // ws is a dev-side dependency bundled into the host artifact; everything
    // else (zod, the harness peer packages) stays external for the host.
    onlyBundle: ['ws'],
  },
  outputOptions: {
    chunkFileNames: '[name].js',
  },
}, {
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: [...CLIENT_BUNDLED],
    onlyBundle: [...CLIENT_BUNDLED],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}]

export default config
