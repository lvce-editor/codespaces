import { InvalidPathError } from '../../shared/src/Errors.ts'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { root as repositoryRoot } from './root.ts'

const root = path.join(repositoryRoot, 'dist')
const mime: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}
createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/codespaces/')) {
      res.writeHead(404)
      res.end()
      return
    }
    let file = path.resolve(
      root,
      '.' + decodeURIComponent(url.pathname.slice('/codespaces'.length)),
    )
    if (file !== root && !file.startsWith(root + path.sep))
      throw new InvalidPathError('Invalid path')
    const info = await stat(file)
    if (info.isDirectory()) file = path.join(file, 'index.html')
    res.setHeader(
      'content-type',
      mime[path.extname(file)] || 'application/octet-stream',
    )
    res.end(await readFile(file))
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}).listen(Number(process.env.LVCE_CODESPACES_TEST_PORT || 4173), '127.0.0.1')
