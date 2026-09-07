import type { ForwardedPort, PortProvider } from '@lvce-editor/api'
import { parse, type ParseError } from 'jsonc-parser'
import { fileSystem } from '../FileSystem/FileSystem.ts'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const getConfiguredPorts = (
  source: string,
  authority: string,
): readonly ForwardedPort[] => {
  // Manual gateways use their forwarded hostname as the filesystem authority.
  const name = authority.replace(/-3774\.app\.github\.dev$/, '')
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) return []
  const errors: ParseError[] = []
  const config = asObject(parse(source, errors, { allowTrailingComma: true }))
  if (errors.length || !Array.isArray(config.forwardPorts)) return []
  const ports = new Map<number, ForwardedPort>()
  for (const value of config.forwardPorts) {
    const port =
      typeof value === 'number'
        ? value
        : typeof value === 'string' &&
            /^(localhost|127\.0\.0\.1):\d+$/.test(value)
          ? Number(value.slice(value.lastIndexOf(':') + 1))
          : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    ports.set(port, {
      port,
      forwardedAddress: `https://${name}-${port}.app.github.dev/`,
      origin: 'devcontainer.json',
    })
  }
  return [...ports.values()].sort((a, b) => a.port - b.port)
}

export const createPortProvider = (
  readFile: (uri: string) => Promise<string> = fileSystem.readFile,
): PortProvider => ({
  scheme: 'codespaces',
  async providePorts(workspaceUri) {
    const uri = new URL(workspaceUri)
    if (uri.protocol !== 'codespaces:') return []
    const root = workspaceUri.replace(/\/$/, '')
    for (const path of [
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
    ]) {
      let source: string
      try {
        source = await readFile(`${root}/${path}`)
      } catch (error) {
        if (
          (error as { code?: string }).code === 'ENOENT' ||
          (error instanceof Error && error.message.includes('ENOENT'))
        )
          continue
        throw error
      }
      return getConfiguredPorts(source, uri.host)
    }
    return []
  },
})
