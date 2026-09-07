import { Buffer } from 'buffer'
import { encode, decode } from './Codec.ts'
import { ByteStream, maximumBytes } from './Stream.ts'

export const serverCommit = 'a44adf7f53e00964ab890f9f8758a334f1fc15bc'
export const serverVersion = '1.136.1'
const channel = 'remoteterminal'
type Pending = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ManagementConnection {
  private readonly io: ByteStream
  readonly name: string
  private sent = 0
  private received = 0
  private requestId = 0
  private unacked = new Map<number, Buffer>()
  private unackedSize = 0
  private paused = false
  private queued: Buffer[] = []
  private calls = new Map<number, Pending>()
  private events = new Map<number, (value: any) => void>()
  private initialized = Promise.withResolvers<void>()
  private closed = false
  private keepAlive: ReturnType<typeof setInterval> | undefined
  onClose: (error: Error) => void = () => {}
  constructor(io: ByteStream, name: string) {
    this.io = io
    this.name = name
    void this.initialized.promise.catch(() => {})
  }
  private frame(type: number, bytes: Buffer = Buffer.alloc(0), id = 0): Buffer {
    const header = Buffer.alloc(13)
    header[0] = type
    header.writeUInt32BE(id, 1)
    header.writeUInt32BE(type === 2 ? 0 : this.received, 5)
    header.writeUInt32BE(bytes.length, 9)
    return Buffer.concat([header, bytes])
  }
  private send(type: number, bytes: Buffer = Buffer.alloc(0)): void {
    if (this.closed) throw new Error('Connection closed')
    const frame = this.frame(type, bytes, type === 1 ? ++this.sent : 0)
    if (type === 1) {
      this.unackedSize += frame.length
      if (this.unackedSize > maximumBytes)
        throw new Error('Remote peer is not acknowledging requests')
      this.unacked.set(this.sent, frame)
    }
    if (this.paused && type === 1) this.queued.push(frame)
    else this.io.write(frame)
  }
  private async readFrame() {
    const header = await this.io.read(13)
    const ack = header.readUInt32BE(5)
    if (ack > this.sent) throw new Error('Invalid protocol acknowledgement')
    for (const [id, bytes] of this.unacked) {
      if (id > ack) break
      this.unackedSize -= bytes.length
      this.unacked.delete(id)
    }
    return {
      type: header[0],
      id: header.readUInt32BE(1),
      bytes: await this.io.read(header.readUInt32BE(9)),
    }
  }
  private async control(): Promise<any> {
    while (true) {
      const message = await this.readFrame()
      if (message.type === 9 || message.type === 3) continue
      if (message.type !== 2) throw new Error('Incompatible VS Code handshake')
      const value = JSON.parse(message.bytes.toString())
      if (value.type === 'error')
        throw new Error(
          'VS Code rejected the connection. Check server version and authorization.',
        )
      return value
    }
  }
  async connect(port: number, token: string): Promise<void> {
    // skipWebSocketFrames makes the HTTP upgrade a raw persistent-protocol stream.
    this.io.write(
      `GET /?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=true HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    )
    if ((await this.io.headers()).status !== 101)
      throw new Error('VS Code server refused the socket upgrade')
    this.send(
      2,
      Buffer.from(
        JSON.stringify({
          type: 'auth',
          auth: token,
          data: crypto.randomUUID(),
        }),
      ),
    )
    if ((await this.control()).type !== 'sign')
      throw new Error('Incompatible VS Code server challenge')
    this.send(
      2,
      Buffer.from(
        JSON.stringify({
          type: 'connectionType',
          commit: serverCommit,
          signedData: token,
          desiredConnectionType: 1,
        }),
      ),
    )
    if ((await this.control()).type !== 'ok')
      throw new Error('VS Code management handshake failed')
    this.send(
      1,
      encode({
        remoteAuthority: `codespaces+${this.name}`,
        clientId: 'renderer',
      }),
    )
    this.message([200], undefined)
    void this.pump().catch((error: Error) => this.close(error))
    this.keepAlive = setInterval(() => {
      try {
        this.send(9)
      } catch (error) {
        this.close(error as Error)
      }
    }, 5000)
    await this.initialized.promise
  }
  private message(header: unknown[], body: unknown): void {
    this.send(1, Buffer.concat([encode(header), encode(body)]))
  }
  private async pump(): Promise<void> {
    while (!this.closed) {
      const message = await this.readFrame()
      if (message.type === 5) throw new Error('VS Code server disconnected')
      if (message.type === 7) {
        this.paused = true
        continue
      }
      if (message.type === 8) {
        this.paused = false
        for (const frame of this.queued.splice(0)) this.io.write(frame)
        continue
      }
      if (message.type === 6) {
        for (const frame of this.unacked.values()) this.io.write(frame)
        continue
      }
      if (message.type !== 1) continue
      if (message.id <= this.received) {
        this.send(3)
        continue
      }
      if (message.id !== this.received + 1) {
        this.send(6)
        continue
      }
      this.received = message.id
      this.send(3)
      const header = decode(message.bytes)
      const body = decode(message.bytes, header.offset).value
      const [type, id] = header.value
      if (type === 200) this.initialized.resolve()
      else if (type === 204) this.events.get(id)?.(body)
      else if (type === 201 || type === 202 || type === 203) {
        const pending = this.calls.get(id)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.calls.delete(id)
        if (type === 201) pending.resolve(body)
        else
          pending.reject(new Error(body?.message || 'Remote operation failed'))
      } else if (type === 100) {
        this.message([202, id], {
          name: 'Error',
          message: 'Client service unavailable in the browser proof',
          stack: [],
        })
      }
    }
  }
  call(service: string, method: string, args: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Connection closed'))
    if (this.calls.size >= 128)
      return Promise.reject(new Error('Too many pending remote operations'))
    const id = this.requestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id)
        try {
          this.message([101, id], undefined)
        } catch {
          /* disconnected */
        }
        reject(new Error(`Remote ${method} timed out`))
      }, 60_000)
      this.calls.set(id, { resolve, reject, timer })
      try {
        this.message([100, id, service, method], args)
      } catch (error) {
        clearTimeout(timer)
        this.calls.delete(id)
        reject(error)
      }
    })
  }
  listen(
    service: string,
    event: string,
    listener: (value: any) => void,
  ): () => void {
    const id = this.requestId++
    this.events.set(id, listener)
    this.message([102, id, service, event], undefined)
    return () => {
      this.events.delete(id)
      if (!this.closed) this.message([103, id], undefined)
    }
  }
  uri(path: string) {
    if (!path.startsWith('/') || path.includes('\0'))
      throw new Error('Expected an absolute workspace path')
    return {
      scheme: 'vscode-remote',
      authority: `codespaces+${this.name}`,
      path,
      query: '',
      fragment: '',
    }
  }
  files(method: string, args: unknown[]): Promise<any> {
    return this.call('remoteFilesystem', method, args)
  }
  terminal(method: string, args: unknown): Promise<any> {
    return this.call(channel, method, args)
  }
  close(error = new Error('Disconnected')): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.keepAlive)
    this.initialized.reject(error)
    for (const pending of this.calls.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.calls.clear()
    this.events.clear()
    this.unacked.clear()
    this.queued = []
    this.io.close()
    this.onClose(error)
  }
}
