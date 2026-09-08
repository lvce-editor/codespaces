import {
  CodespaceSetupTimeoutError,
  ConnectionCancelledError,
} from '../../../../shared/src/Errors.ts'

// Editor commands do not accept an AbortSignal. Stop waiting when the connection
// is cancelled so a lost worker response cannot keep Connect locked forever.
export const waitForWorkspace = async (
  pending: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> => {
  const { promise, reject } = Promise.withResolvers<never>()
  const cancel = (): void =>
    reject(new ConnectionCancelledError('Connection cancelled'))
  const timer = setTimeout(
    () =>
      reject(
        new CodespaceSetupTimeoutError(
          'Opening the remote workspace timed out. Run Codespaces: Connect to Codespace to try again.',
        ),
      ),
    30_000,
  )
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    await Promise.race([pending, promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
