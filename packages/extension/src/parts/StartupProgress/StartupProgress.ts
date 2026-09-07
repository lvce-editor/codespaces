export const createStartupProgress = (
  name: string,
  write: (message: string) => Promise<void>,
  now: () => number = Date.now,
) => {
  const started = now()
  const history: string[] = []
  let previous = ''
  return async (message: string, finished = false): Promise<void> => {
    const seconds = Math.floor((now() - started) / 1000)
    const elapsed = `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    if (message !== previous) {
      history.push(`[${elapsed}] ${message}`)
      if (history.length > 50) history.shift()
      previous = message
    }
    await write(
      `Connecting to ${name}\n${history.join('\n')}\n\nElapsed: ${elapsed}\n` +
        (finished
          ? 'Use Codespaces: Stop Codespace to stop GitHub compute. Disconnect only closes the editor connection.\n'
          : 'Codespaces compute is billed by GitHub while running.\nRun Codespaces: Disconnect to cancel.\n'),
    )
  }
}
