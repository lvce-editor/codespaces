import { parse, type ParseError } from 'jsonc-parser'

export interface AppPreview {
  readonly port: number
  readonly label: string
  readonly url: string
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const getAppPreview = (
  source: string,
  name: string,
): AppPreview | undefined => {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) return
  const errors: ParseError[] = []
  const config = object(parse(source, errors, { allowTrailingComma: true }))
  if (errors.length || !Array.isArray(config.forwardPorts)) return
  const attributes = object(config.portsAttributes)
  for (const value of config.forwardPorts) {
    const port =
      typeof value === 'number'
        ? value
        : typeof value === 'string' &&
            /^(localhost|127\.0\.0\.1):\d+$/.test(value)
          ? Number(value.slice(value.lastIndexOf(':') + 1))
          : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    const settings = object(attributes[String(port)])
    if (settings.onAutoForward !== 'openPreview') continue
    return {
      port,
      label:
        typeof settings.label === 'string'
          ? settings.label
          : 'Application Preview',
      url: `https://${name}-${port}.app.github.dev/`,
    }
  }
}

export const readAppPreview = async (
  workspaceUri: string,
  name: string,
  readFile: (uri: string) => Promise<string>,
  signal: AbortSignal,
): Promise<AppPreview | undefined> => {
  for (const path of [
    '.devcontainer/devcontainer.json',
    '.devcontainer.json',
  ]) {
    signal.throwIfAborted()
    let source: string
    try {
      source = await readFile(`${workspaceUri.replace(/\/$/, '')}/${path}`)
    } catch (error) {
      signal.throwIfAborted()
      if (
        (error as { code?: string }).code === 'ENOENT' ||
        (error instanceof Error && error.message.includes('ENOENT'))
      )
        continue
      throw error
    }
    signal.throwIfAborted()
    return getAppPreview(source, name)
  }
}
