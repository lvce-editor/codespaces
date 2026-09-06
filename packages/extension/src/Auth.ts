import { getAccessToken } from '@lvce-editor/api'
import { backendUrl } from './Urls.ts'

export const getToken = async (): Promise<string> => {
  const token = await getAccessToken({ refresh: 'if-needed' })
  if (!token)
    throw new Error(
      'Sign in to LVCE using the account button, then run this command again.',
    )
  return token
}

export const getAccountId = async (token: string): Promise<string> => {
  const response = await fetch(`${backendUrl}/oidc/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  if (!response.ok)
    throw new Error(
      `LVCE account lookup failed (${response.status}). Sign in again.`,
    )
  const account = await response.json()
  if (typeof account.sub !== 'string' || !account.sub)
    throw new Error('LVCE returned an invalid account identifier.')
  return account.sub
}
