import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('packages/extension/dist', { recursive: true })
await build({
  entryPoints: ['packages/extension/src/codespacesMain.ts'],
  outfile: 'packages/extension/dist/codespacesMain.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external: ['node:*', 'electron'],
  target: 'esnext',
})
await mkdir('.tmp/setup', { recursive: true })
await build({
  entryPoints: ['packages/server/src/parts/Setup/Setup.ts'],
  outfile: '.tmp/setup/setup.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
