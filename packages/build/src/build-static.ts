import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bundle } from './bundle.ts'
import { root } from './root.ts'

const { exportStatic } = await import(
  import.meta.resolve('@lvce-editor/shared-process')
)

await bundle()
process.env.PATH_PREFIX = '/codespaces'
const { commitHash } = await exportStatic({
  root,
  extensionPath: join(root, 'packages/extension'),
})
await cp(
  join(root, 'packages/extension/dist'),
  join(root, `dist/${commitHash}/extensions/builtin.codespaces/dist`),
  { recursive: true },
)
await cp(join(root, '.tmp/setup/setup.mjs'), join(root, 'dist/setup.mjs'))
await cp(
  join(root, 'packages/extension/static/setup.html'),
  join(root, 'dist/setup.html'),
)
const callbackPath = join(root, 'dist/auth/callback.html')
const callback = await readFile(callbackPath, 'utf8')
await writeFile(
  callbackPath,
  callback.replace(
    "window.location.replace('/')",
    "window.location.replace('/codespaces/')",
  ),
)
await writeFile(join(root, 'dist/.nojekyll'), '')
