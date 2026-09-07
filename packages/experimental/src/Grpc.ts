import { Buffer } from 'buffer'
import { ByteStream } from './Stream.ts'
import { serverCommit } from './Protocol.ts'

const varint = (value: number): Buffer => {
  const bytes = []
  do {
    const byte = value & 127
    value >>>= 7
    bytes.push(byte | (value ? 128 : 0))
  } while (value)
  return Buffer.from(bytes)
}
export const protoString = (field: number, value: string): Buffer => {
  const data = Buffer.from(value)
  return Buffer.concat([varint((field << 3) | 2), varint(data.length), data])
}
export const decodeProto = (bytes: Buffer): Map<number, number | string> => {
  let offset = 0
  const readNumber = (): number => {
    let result = 0
    for (let shift = 0; shift < 35; shift += 7) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf')
      const byte = bytes[offset++]
      result |= (byte & 127) << shift
      if (!(byte & 128)) return result
    }
    throw new Error('Invalid protobuf integer')
  }
  const fields = new Map<number, number | string>()
  while (offset < bytes.length) {
    const key = readNumber()
    if ((key & 7) === 0) fields.set(key >>> 3, readNumber())
    else if ((key & 7) === 2) {
      const length = readNumber()
      if (length < 0 || length > bytes.length - offset)
        throw new Error('Invalid protobuf length')
      fields.set(
        key >>> 3,
        bytes.subarray(offset, (offset += length)).toString(),
      )
    } else throw new Error('Unsupported Codespaces protobuf field')
  }
  return fields
}
export const parseGrpc = (
  bytes: Buffer,
  headers = new Map<string, string>(),
): Buffer => {
  let data: Buffer = Buffer.alloc(0)
  let status = headers.get('grpc-status')
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 5) throw new Error('Truncated gRPC frame')
    const flag = bytes[offset]
    const length = bytes.readUInt32BE(offset + 1)
    offset += 5
    if (length > bytes.length - offset)
      throw new Error('Truncated gRPC payload')
    const frame = bytes.subarray(offset, (offset += length))
    if (flag === 0) data = frame
    else if (flag === 128) {
      for (const line of frame.toString().split('\r\n')) {
        if (line.toLowerCase().startsWith('grpc-status:'))
          status = line.slice(12).trim()
      }
    } else throw new Error('Unsupported compressed gRPC response')
  }
  if (status !== '0')
    throw new Error(
      `Codespaces agent rejected the request (gRPC ${status || 'missing status'}). This private interface may have changed.`,
    )
  return data
}
export const rpc = async (
  io: ByteStream,
  service: string,
  method: string,
  payload: Buffer,
): Promise<Buffer> => {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  try {
    io.write(
      `POST /Codespaces.Grpc.${service}Service.v1.${service}/${method} HTTP/1.1\r\nHost: localhost:16635\r\nConnection: close\r\nContent-Type: application/grpc-web+proto\r\nX-Grpc-Web: 1\r\nGrpc-Timeout: 120S\r\nAuthorization: Bearer token\r\nContent-Length: ${5 + payload.length}\r\n\r\n`,
    )
    io.write(Buffer.concat([header, payload]))
    const response = await io.headers()
    if (response.status !== 200)
      throw new Error(`Codespaces agent HTTP ${response.status}`)
    return parseGrpc(await io.body(response.headers), response.headers)
  } finally {
    io.close()
  }
}
export const startServer = async (
  io: ByteStream,
): Promise<{ port: number; token: string }> => {
  const fields = decodeProto(
    await rpc(
      io,
      'VSCodeServerHost',
      'StartRemoteServerAsync',
      Buffer.concat([protoString(1, serverCommit), protoString(2, 'stable')]),
    ),
  )
  const port = fields.get(1)
  const token = fields.get(2)
  if (
    typeof port !== 'number' ||
    port < 1024 ||
    port > 65535 ||
    typeof token !== 'string' ||
    !token ||
    token.length > 32768
  )
    throw new Error('Codespaces returned invalid VS Code server credentials')
  return { port, token }
}
