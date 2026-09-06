import type { FileSystemDirent, FileSystemProvider } from '@lvce-editor/api'
import * as RemoteServerConnection from './Connection.ts'

export type Invoke = (
  method: string,
  ...params: readonly unknown[]
) => Promise<unknown>

export interface RemoteServerFileSystem extends FileSystemProvider {
  readonly mkdir: (uri: string) => Promise<void>
  readonly readDirWithFileTypes: (
    uri: string,
  ) => Promise<readonly FileSystemDirent[]>
  readonly readFile: (uri: string) => Promise<string>
  readonly remove: (uri: string) => Promise<void>
  readonly rename: (oldUri: string, newUri: string) => Promise<void>
  readonly writeFile: (uri: string, content: string) => Promise<void>
}

const getLocation = (
  uri: string,
): { readonly authority: string; readonly path: string } => {
  const url = new URL(uri)
  if (url.protocol !== 'codespaces:' || !url.host) {
    throw new TypeError(`Invalid remote server URI: ${uri}`)
  }
  return {
    authority: url.host,
    path: decodeURIComponent(url.pathname),
  }
}

const toFileUri = (filePath: string): string => {
  const url = new URL('file:///')
  url.pathname = filePath
  return url.href
}

const encodeBase64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary)
}

const decodeBase64 = (value: string): string => {
  const binary = atob(value)
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.codePointAt(0) || 0),
  )
}

const invokeFileSystem = (
  invoke: Invoke,
  method: string,
  uri: string,
  ...params: readonly unknown[]
): Promise<unknown> => {
  const location = getLocation(uri)
  RemoteServerConnection.assertAuthority(location.authority)
  return invoke(method, toFileUri(location.path), ...params)
}

const requireMutable = (uri: string): void => {
  if (getLocation(uri).path === '/') {
    throw new Error('Cannot modify the remote root folder')
  }
}

export const createRemoteServerFileSystem = (
  invoke: Invoke = RemoteServerConnection.invoke,
): RemoteServerFileSystem => {
  return {
    id: 'codespaces',
    isReadonly: (): boolean => false,
    mkdir: async (uri): Promise<void> => {
      requireMutable(uri)
      await invokeFileSystem(invoke, 'FileSystem.mkdir', uri)
    },
    readDirWithFileTypes: async (uri): Promise<readonly FileSystemDirent[]> => {
      const value = await invokeFileSystem(
        invoke,
        'FileSystem.readDirWithFileTypes',
        uri,
      )
      if (!Array.isArray(value)) {
        throw new TypeError('Remote server returned invalid directory entries')
      }
      return value
        .map((entry) => (entry?.type === 9 ? { ...entry, type: 7 } : entry))
        .toSorted((a, b) => String(a?.name).localeCompare(String(b?.name)))
    },
    readFile: async (uri): Promise<string> => {
      const value = await invokeFileSystem(
        invoke,
        'FileSystem.readFile',
        uri,
        'base64',
      )
      if (typeof value !== 'string') {
        throw new TypeError('Remote server returned invalid file content')
      }
      return decodeBase64(value)
    },
    remove: async (uri): Promise<void> => {
      requireMutable(uri)
      await invokeFileSystem(invoke, 'FileSystem.forceRemove', uri)
    },
    rename: async (oldUri, newUri): Promise<void> => {
      const oldLocation = getLocation(oldUri)
      const newLocation = getLocation(newUri)
      if (oldLocation.authority !== newLocation.authority) {
        throw new Error('Cannot rename across remote servers')
      }
      RemoteServerConnection.assertAuthority(oldLocation.authority)
      requireMutable(oldUri)
      requireMutable(newUri)
      try {
        await invoke('FileSystem.stat', toFileUri(newLocation.path))
        const error = new Error('File exists') as Error & { code?: string }
        error.code = 'EEXIST'
        throw error
      } catch (error) {
        if ((error as Error & { code?: string }).code !== 'ENOENT') {
          throw error
        }
      }
      await invoke(
        'FileSystem.rename',
        toFileUri(oldLocation.path),
        toFileUri(newLocation.path),
      )
    },
    writeFile: async (uri, content): Promise<void> => {
      requireMutable(uri)
      await invokeFileSystem(
        invoke,
        'FileSystem.writeFile',
        uri,
        encodeBase64(content),
        'base64',
      )
    },
  }
}

export const fileSystem = createRemoteServerFileSystem()

export const _decodeBase64 = decodeBase64
export const _encodeBase64 = encodeBase64
export const _getLocation = getLocation
