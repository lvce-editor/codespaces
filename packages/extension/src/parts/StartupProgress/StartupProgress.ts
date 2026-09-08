export const createStartupProgress = (
  name: string,
  write: (message: string) => Promise<void>,
  now: () => number = Date.now,
) => {
  const started = now()
  const history: string[] = []
  let previous = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision = 0
  const update = async (message: string, finished = false): Promise<void> => {
    const current = ++revision
    clearTimeout(timer)
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
    if (!finished && revision === current) {
      timer = setTimeout(() => {
        void update(previous).catch(() => {})
      }, 1000)
    }
  }
  return update
}
