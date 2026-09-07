import {
  AccountLookupError,
  InvalidAccountIdError,
  SignInRequiredError,
} from '../../../../shared/src/Errors.ts'
import { executeCommand, getAccessToken } from '@lvce-editor/api'
import { backendUrl } from '../Urls/Urls.ts'

let initialization: Promise<unknown> | undefined

export const getToken = async (): Promise<string> => {
  // Static exports initialize authentication lazily. Restore callbacks and set
  // the auth worker's backend before asking it to refresh an expired token.
  initialization ||= executeCommand('Layout.refreshAuthState').catch(
    (error) => {
      initialization = undefined
      throw error
    },
  )
  await initialization
  const token = await getAccessToken({ refresh: 'if-needed' })
  if (!token)
    throw new SignInRequiredError(
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
    throw new AccountLookupError(
      `LVCE account lookup failed (${response.status}). Sign in again.`,
    )
  const account = await response.json()
  if (typeof account.sub !== 'string' || !account.sub)
    throw new InvalidAccountIdError(
      'LVCE returned an invalid account identifier.',
    )
  return account.sub
}
