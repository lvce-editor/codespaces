import { build } from 'esbuild'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'
import { root } from './root.ts'

export const bundleExperimental = async (): Promise<void> => {
  await build({
    absWorkingDir: root,
    entryPoints: ['packages/experimental/src/Main.ts'],
    outfile: 'dist/experimental/main.js',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    plugins: [
      {
        name: 'browser-crypto-only',
        setup(build) {
          build.onResolve({ filter: /^\.\/node\/node/ }, (args) => {
            if (
              args.importer.includes('@microsoft/dev-tunnels-ssh/algorithms/')
            )
              return { path: args.path, namespace: 'unused-node-crypto' }
          })
          build.onLoad(
            { filter: /.*/, namespace: 'unused-node-crypto' },
            () => ({ contents: 'module.exports = {}' }),
          )
        },
      },
      polyfillNode(),
    ],
    define: {
      global: 'globalThis',
      'process.release': 'undefined',
      'process.versions.node': 'undefined',
    },
    metafile: true,
  })
}

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
