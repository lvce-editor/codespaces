import { openUri, writeFile } from '@lvce-editor/api'
import { InvalidFileContentError } from '../../../../shared/src/Errors.ts'
import { request } from '../CodespacesApi/CodespacesApi.ts'

export const openCreationLog = async (
  name: string,
  signal: AbortSignal,
): Promise<void> => {
  const { content } = await request<{ content: string }>(
    `/${encodeURIComponent(name)}/creation-log`,
    'GET',
    undefined,
    signal,
  )
  signal.throwIfAborted()
  if (typeof content !== 'string' || !content.trim())
    throw new InvalidFileContentError(
      'The Codespace creation log is not available yet.',
    )
  const directory = `memfs:///codespaces-${encodeURIComponent(name)}`
  const uri = `${directory}/creation.log`
  await writeFile(uri, content)
  signal.throwIfAborted()
  await openUri(uri)
}
