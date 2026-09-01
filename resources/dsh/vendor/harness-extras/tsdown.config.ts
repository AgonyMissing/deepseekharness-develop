import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@deepseek-ai/dsh-client-ui-harness-extras/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-harness-extras", factory: (require) => {`,
    footer: `return module.exports; } });`,
    intro: `var module = { exports: {} }; var exports = module.exports;`,
  },
})
