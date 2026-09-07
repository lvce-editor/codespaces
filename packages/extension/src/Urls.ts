import {
  InvalidAccountIdError,
  InvalidEndpointError,
} from '../../shared/src/Errors.ts'
export const backendUrl = 'https://lvce-editor.dev'
export const siteUrl = 'https://lvce-editor.github.io/codespaces/'
export const port = 3774

export const getEndpoint = (input: string): URL => {
  const value = input.trim()
  const url = value.includes('://')
    ? new URL(value)
    : new URL(`https://${value}-${port}.app.github.dev`)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new InvalidEndpointError(
      'Enter a codespace name or its forwarded HTTPS origin, without a path or token.',
    )
  }
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url
  if (
    url.protocol !== 'https:' ||
    url.port ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+\.app\.github\.dev$/.test(url.hostname)
  ) {
    throw new InvalidEndpointError(
      'Expected a GitHub Codespaces forwarded URL such as https://your-codespace-3774.app.github.dev.',
    )
  }
  return url
}

export const shellQuote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'"
export const getSetupCommand = (owner: string): string => {
  if (!owner || owner.length > 256)
    throw new InvalidAccountIdError(
      'LVCE did not return an account identifier.',
    )
  return `curl --fail --silent --show-error ${siteUrl}setup.mjs -o /tmp/lvce-codespaces-setup.mjs && node /tmp/lvce-codespaces-setup.mjs --owner=${shellQuote(owner)}`
}
