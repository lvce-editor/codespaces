import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  mkdtemp,
  access,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createGateway } from './Gateway.ts'
const version = 'v0.10.7'
const nodeVersion = 'v24.15.0'
const serverUrl = `https://github.com/lvce-editor/remote-ssh/releases/download/${version}/lvce-remote-ssh-server-${version}.tar.gz`
const serverHash =
  '044e89fcbc9f218c246042dc2038d0539fd411cd85f5bf6ecd14e0154e0aac79'
const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-x64.tar.gz`
const nodeHash =
  '44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89'
const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    )
  })
const installArchive = async (
  url: string,
  hash: string,
  destination: string,
): Promise<void> => {
  try {
    if ((await readFile(path.join(destination, '.sha256'), 'utf8')) === hash)
      return
  } catch {}
  const parent = path.dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(path.join(parent, '.install-'))
  try {
    console.log('Downloading verified LVCE runtime…')
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Download failed (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new Error('Download checksum mismatch')
    const archive = path.join(temporary, 'archive.tar.gz')
    const unpacked = path.join(temporary, 'unpacked')
    await writeFile(archive, bytes, { mode: 0o600 })
    await mkdir(unpacked)
    await run('tar', ['-xzf', archive, '-C', unpacked])
    await writeFile(path.join(unpacked, '.sha256'), hash)
    await rename(unpacked, destination)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
const main = async (): Promise<void> => {
  const owner = process.argv.find((arg) => arg.startsWith('--owner='))?.slice(8)
  const local = process.argv.includes('--local-test')
  const relay = process.argv.includes('--relay')
  if (!owner && !relay)
    throw new Error(
      'Run Codespaces: Set Up a Codespace in LVCE to get a command for your account.',
    )
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('This first version supports Linux x64 Codespaces.')
  const codespace = process.env.CODESPACE_NAME
  if (
    !local &&
    !relay &&
    (!codespace || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(codespace))
  )
    throw new Error('Run this command inside a GitHub Codespace.')
  const root =
    process.env.LVCE_CODESPACES_ROOT || path.join(homedir(), '.lvce-codespaces')
  const runtime = path.join(root, 'runtime', nodeVersion)
  const server = path.join(root, 'server', version)
  await installArchive(nodeUrl, nodeHash, runtime)
  await installArchive(serverUrl, serverHash, server)
  const node = path.join(
    runtime,
    `node-${nodeVersion}-linux-x64`,
    'bin',
    'node',
  )
  const entry = path.join(server, 'lvce-remote-ssh-server.mjs')
  await access(entry)
  const child = spawn(node, [entry, 'connect-or-start'], {
    env: { ...process.env, LVCE_REMOTE_SSH_ROOT: root },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const ready = await new Promise<{ backend: { port: number; token: string } }>(
    (resolve, reject) => {
      const lines = createInterface({ input: child.stdout })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('LVCE backend startup timed out'))
      }, 120_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        lines.close()
        reject(new Error('LVCE backend stopped before connecting'))
      })
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line)
          if (message.type !== 'ready') return
          if (
            !Number.isInteger(message.backend?.port) ||
            typeof message.backend?.token !== 'string'
          )
            throw new Error('Invalid backend response')
          clearTimeout(timer)
          lines.close()
          resolve(message)
        } catch {
          clearTimeout(timer)
          lines.close()
          child.kill()
          reject(new Error('Invalid backend startup response'))
        }
      })
    },
  )
  if (relay) {
    console.log(
      JSON.stringify({
        type: 'lvce-relay-ready',
        backend: ready.backend,
        workspacePath: process.cwd(),
      }),
    )
    const stop = (): void => {
      child.kill()
    }
    process.stdin.resume()
    process.stdin.once('end', stop)
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    return
  }
  const publicUrl = local
    ? 'http://127.0.0.1:3774'
    : `https://${codespace}-3774.app.github.dev`
  let gateway
  try {
    gateway = await createGateway({
      owner: owner!,
      backendPort: ready.backend.port,
      backendToken: ready.backend.token,
      port: 3774,
      publicUrl,
      allowedOrigin: local
        ? 'http://127.0.0.1:4173'
        : 'https://lvce-editor.github.io',
      workspacePath: process.cwd(),
    })
  } catch (error) {
    child.kill()
    throw error
  }
  console.log(
    `\nLVCE gateway ready: ${publicUrl}\nOnly the LVCE account used to generate this setup command can connect.\nKeep this terminal running. In Codespaces, forward port 3774 and set its visibility to Public.\nThe gateway enforces LVCE authentication; do not expose the internal backend port.\nThen open https://lvce-editor.github.io/codespaces/ and run Codespaces: Connect to Codespace.\nEnter: ${codespace || publicUrl}\n`,
  )
  const stop = async (): Promise<void> => {
    await gateway.close()
    child.kill()
    process.exitCode = 0
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
  child.once('exit', () => void gateway.close())
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Setup failed')
  process.exitCode = 1
})
