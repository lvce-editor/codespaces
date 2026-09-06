import './build.ts'
import { cp, writeFile } from 'node:fs/promises'
const { exportStatic } = await import(
  import.meta.resolve('@lvce-editor/shared-process')
)

process.env.PATH_PREFIX = '/codespaces'
const { commitHash } = await exportStatic({
  root: process.cwd(),
  extensionPath: 'packages/extension',
})
await cp(
  'packages/extension/dist',
  `dist/${commitHash}/extensions/builtin.codespaces/dist`,
  { recursive: true },
)
await cp('.tmp/setup/setup.mjs', 'dist/setup.mjs')
await cp('packages/extension/static/setup.html', 'dist/setup.html')
await writeFile('dist/.nojekyll', '')
