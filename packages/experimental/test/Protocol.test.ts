import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Duplex } from 'node:stream'
import { Buffer } from 'buffer'
import { encode, decode } from '../src/Codec.ts'
import { ByteStream } from '../src/Stream.ts'
import { parseGrpc, decodeProto, protoString } from '../src/Grpc.ts'

test('IPC matches VS Code wire fixtures, including negative integers and nested VSBuffer', () => {
  assert.equal(encode('hello').toString('hex'), '010568656c6c6f')
  assert.equal(encode(-1).toString('hex'), '06ffffffff0f')
  assert.equal(
    encode([100, 0, 'remoteFilesystem', 'readFile']).toString('hex'),
    '040406640600011072656d6f746546696c6573797374656d01087265616446696c65',
  )
  assert.equal(encode(new Uint8Array([0, 255])).toString('hex'), '030200ff')
  const value = [
    undefined,
    true,
    null,
    -1,
    'snow ❄',
    { scheme: 'vscode-remote', path: '/x' },
    Buffer.from('content'),
  ]
  assert.deepEqual(decode(encode(value)).value, value)
  assert.throws(() => decode(Buffer.from([1, 128])), /Truncated/)
  assert.throws(() => decode(Buffer.from([3, 100])), /length/)
})

const grpcFrame = (flag: number, bytes: Buffer): Buffer => {
  const header = Buffer.alloc(5)
  header[0] = flag
  header.writeUInt32BE(bytes.length, 1)
  return Buffer.concat([header, bytes])
}
test('gRPC requires successful trailers, even after a valid data frame and HTTP 200', () => {
  const data = Buffer.concat([
    Buffer.from([8, 128, 128, 2]),
    protoString(2, 'server-token'),
  ])
  const frames = Buffer.concat([
    grpcFrame(0, data),
    grpcFrame(128, Buffer.from('grpc-status: 0\r\n')),
  ])
  assert.equal(decodeProto(parseGrpc(frames)).get(1), 32768)
  assert.equal(decodeProto(parseGrpc(frames)).get(2), 'server-token')
  assert.throws(() => parseGrpc(grpcFrame(0, data)), /missing status/)
  assert.throws(
    () =>
      parseGrpc(
        Buffer.concat([
          grpcFrame(0, data),
          grpcFrame(128, Buffer.from('grpc-status: 7\r\n')),
        ]),
      ),
    /gRPC 7/,
  )
  assert.throws(() => parseGrpc(grpcFrame(1, data)), /compressed/)
  assert.throws(() => parseGrpc(Buffer.from([0, 0])), /Truncated/)
})

test('HTTP parser handles byte-fragmented chunked responses and preserves bytes after upgrade', async () => {
  const source = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const controller = new AbortController()
  const io = new ByteStream(source, controller.signal)
  const wire = Buffer.from(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;test=yes\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: yes\r\n\r\nREST',
  )
  const reading = (async () => {
    const response = await io.headers()
    assert.equal(response.status, 200)
    assert.equal((await io.body(response.headers)).toString(), 'abcde')
    assert.equal((await io.read(4)).toString(), 'REST')
  })()
  for (const byte of wire) {
    source.push(Buffer.from([byte]))
    await Promise.resolve()
  }
  await reading
  io.close()
})

test('cancellation rejects a pending stream read and destroys its stream', async () => {
  const source = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const controller = new AbortController()
  const io = new ByteStream(source, controller.signal)
  const reading = io.read(1)
  controller.abort()
  await assert.rejects(reading, /cancelled/)
  assert.equal(source.destroyed, true)
  io.close()
})

test('management session authenticates, serves files and terminal events, and rejects work on interruption', async () => {
  const { duplexPair } = await import('node:stream')
  const { ManagementConnection, serverCommit } =
    await import('../src/Protocol.ts')
  const [client, server] = duplexPair()
  const controller = new AbortController()
  const io = new ByteStream(client, controller.signal)
  const peer = new ByteStream(server, controller.signal)
  const connection = new ManagementConnection(io, 'fixture-space')
  const receive = async () => {
    const header = await peer.read(13)
    return { type: header[0], bytes: await peer.read(header.readUInt32BE(9)) }
  }
  const send = (type: number, payload: Buffer, id = 0, ack = 0) => {
    const header = Buffer.alloc(13)
    header[0] = type
    header.writeUInt32BE(id, 1)
    header.writeUInt32BE(ack, 5)
    header.writeUInt32BE(payload.length, 9)
    // Coalescing and fragmentation both occur on real tunnel streams.
    const wire = Buffer.concat([header, payload])
    peer.write(wire.subarray(0, 7))
    peer.write(wire.subarray(7))
  }
  const ipc = (header: unknown[], body: unknown, id: number, ack: number) =>
    send(1, Buffer.concat([encode(header), encode(body)]), id, ack)
  const receiveRequest = async () => {
    let message = await receive()
    while (message.type !== 1) message = await receive()
    const header = decode(message.bytes)
    return {
      header: header.value,
      body: decode(message.bytes, header.offset).value,
    }
  }
  const serving = (async () => {
    const request = await peer.line()
    assert.match(request, /skipWebSocketFrames=true HTTP\/1.1$/)
    while (await peer.line()) {
      /* HTTP upgrade headers */
    }
    peer.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n')
    const auth = JSON.parse((await receive()).bytes.toString())
    assert.equal(auth.type, 'auth')
    assert.equal(auth.auth, 'fixture-server-token')
    send(2, Buffer.from('{"type":"sign","data":"challenge"}'))
    const reply = JSON.parse((await receive()).bytes.toString())
    assert.deepEqual(reply, {
      type: 'connectionType',
      commit: serverCommit,
      signedData: 'fixture-server-token',
      desiredConnectionType: 1,
    })
    assert.equal(reply.signedData, auth.auth)
    send(2, Buffer.from('{"type":"ok"}'))
    assert.deepEqual(decode((await receive()).bytes).value, {
      remoteAuthority: 'codespaces+fixture-space',
      clientId: 'renderer',
    })
    assert.deepEqual((await receiveRequest()).header, [200])
    // Literal VS Code ChannelServer Initialize packet: array [200], undefined.
    send(1, Buffer.from([4, 1, 6, 200, 1, 0]), 1, 2)
    const listing = await receiveRequest()
    assert.deepEqual(listing.header.slice(2), ['remoteFilesystem', 'readdir'])
    assert.deepEqual(listing.body[0], {
      scheme: 'vscode-remote',
      authority: 'codespaces+fixture-space',
      path: '/workspaces/fixture',
      query: '',
      fragment: '',
    })
    ipc([201, listing.header[1]], [['sample.txt', 1]], 2, 3)
    const write = await receiveRequest()
    assert.deepEqual(write.header.slice(2), ['remoteFilesystem', 'writeFile'])
    assert.equal(write.body[1].toString(), 'proof file contents')
    assert.deepEqual(write.body[2], { create: true, overwrite: true })
    ipc([201, write.header[1]], undefined, 3, 4)
    const listen = await receiveRequest()
    assert.deepEqual(listen.header.slice(2), [
      'remoteterminal',
      '$onProcessDataEvent',
    ])
    ipc([204, listen.header[1]], { id: 17, event: 'terminal output' }, 4, 5)
    const input = await receiveRequest()
    assert.deepEqual(input.header.slice(2), ['remoteterminal', '$input'])
    assert.deepEqual(input.body, [17, 'pwd\r'])
    ipc([201, input.header[1]], undefined, 5, 6)
    const pending = await receiveRequest()
    assert.equal(pending.header[3], 'readFile')
    server.destroy()
  })()
  try {
    await connection.connect(3000, 'fixture-server-token')
    assert.deepEqual(
      await connection.files('readdir', [
        connection.uri('/workspaces/fixture'),
      ]),
      [['sample.txt', 1]],
    )
    await connection.files('writeFile', [
      connection.uri('/workspaces/fixture/sample.txt'),
      Buffer.from('proof file contents'),
      { create: true, overwrite: true },
    ])
    const event = Promise.withResolvers<any>()
    connection.listen('remoteterminal', '$onProcessDataEvent', event.resolve)
    assert.deepEqual(await event.promise, { id: 17, event: 'terminal output' })
    await connection.terminal('$input', [17, 'pwd\r'])
    const reading = connection.files('readFile', [
      connection.uri('/workspaces/fixture/sample.txt'),
    ])
    // Node's paired streams do not propagate destroy to the other half.
    await serving
    client.destroy()
    await assert.rejects(reading, /closed/)
    await assert.rejects(
      connection.terminal('$input', [17, 'never replay']),
      /closed/,
    )
  } finally {
    connection.close()
    peer.close()
  }
})
