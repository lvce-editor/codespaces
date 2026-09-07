import { build } from 'esbuild'
import { root } from './root.ts'

export const bundle = async (): Promise<void> => {
  await build({
    absWorkingDir: root,
    entryPoints: ['packages/extension/src/codespacesMain.ts'],
    outfile: 'packages/extension/dist/codespacesMain.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'electron'],
    target: 'esnext',
  })
  await build({
    absWorkingDir: root,
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
}
