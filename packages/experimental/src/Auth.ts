export const backendUrl = 'https://lvce-editor.dev'

// Share the normal LVCE sign-in. Credentials never enter URLs or the proof UI.
// Token refresh stays with the existing editor's auth worker.
const storedAccessToken = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('auth-worker', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('auth')
    }
    request.onerror = () => reject(new Error('Cannot read LVCE sign-in state'))
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('auth')) {
        database.close()
        resolve('')
        return
      }
      const read = database
        .transaction('auth', 'readonly')
        .objectStore('auth')
        .get('accessToken')
      read.onsuccess = () => {
        database.close()
        resolve(typeof read.result === 'string' ? read.result : '')
      }
      read.onerror = () => {
        database.close()
        reject(new Error('Cannot read LVCE sign-in state'))
      }
    }
  })

export const broker = async <T>(
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> => {
  const token = await storedAccessToken()
  if (!token)
    throw new Error('Sign in using the LVCE editor link, then return here.')
  const response = await fetch(`${backendUrl}/codespaces${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    credentials: 'omit',
    redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
  })
  if (response.status === 401)
    throw new Error(
      'LVCE sign-in expired. Open the editor to refresh it, then reconnect.',
    )
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({}))).error ||
        `Connection broker HTTP ${response.status}`,
    )
  return response.status === 204 ? (undefined as T) : response.json()
}
