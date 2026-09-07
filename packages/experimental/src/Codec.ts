import { Buffer } from 'buffer'

// Independent implementation of VS Code's MIT IPC codec, pinned in Protocol.ts.
// Uint8Array represents VSBuffer (wire tag 3), including nested file contents.
export const encode = (value: unknown): Buffer => {
  const parts: Buffer[] = []
  const number = (n: number): void => {
    do {
      const byte = n & 127
      n >>>= 7
      parts.push(Buffer.from([byte | (n ? 128 : 0)]))
    } while (n)
  }
  const visit = (item: unknown): void => {
    if (item === undefined) parts.push(Buffer.from([0]))
    else if (typeof item === 'number' && (item | 0) === item) {
      parts.push(Buffer.from([6]))
      number(item)
    } else if (Array.isArray(item)) {
      parts.push(Buffer.from([4]))
      number(item.length)
      for (const child of item) visit(child)
    } else {
      const bytes =
        item instanceof Uint8Array
          ? Buffer.from(item)
          : Buffer.from(typeof item === 'string' ? item : JSON.stringify(item))
      parts.push(
        Buffer.from([
          item instanceof Uint8Array ? 3 : typeof item === 'string' ? 1 : 5,
        ]),
      )
      number(bytes.length)
      parts.push(bytes)
    }
  }
  visit(value)
  return Buffer.concat(parts)
}

export const decode = (
  bytes: Buffer,
  offset = 0,
): { value: any; offset: number } => {
  const number = (): number => {
    let value = 0
    for (let shift = 0; shift < 35; shift += 7) {
      if (offset >= bytes.length) throw new Error('Truncated IPC integer')
      const byte = bytes[offset++]
      value |= (byte & 127) << shift
      if (!(byte & 128)) return value
    }
    throw new Error('Invalid IPC integer')
  }
  const visit = (depth: number): any => {
    if (depth > 64 || offset >= bytes.length)
      throw new Error('Invalid IPC value')
    const type = bytes[offset++]
    if (type === 0) return undefined
    if (type === 6) return number()
    const length = number()
    if (length < 0 || length > bytes.length - offset)
      throw new Error('Invalid IPC length')
    if (type === 4) return Array.from({ length }, () => visit(depth + 1))
    const data = bytes.subarray(offset, (offset += length))
    if (type === 1) return data.toString('utf8')
    if (type === 2 || type === 3) return data
    if (type === 5) return JSON.parse(data.toString('utf8'))
    throw new Error('Unknown IPC value type')
  }
  return { value: visit(0), offset }
}
