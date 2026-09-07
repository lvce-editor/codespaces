import { ConnectionCancelledError } from '../../../../shared/src/Errors.ts'
export const sleep = async (signal: AbortSignal): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const stop = (): void => {
    clearTimeout(timer)
    reject(new ConnectionCancelledError('Connection cancelled'))
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', stop)
    resolve()
  }, 1500)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  return promise
}
