import { Buffer } from 'buffer'
import type { Duplex } from 'stream'

export const maximumBytes = 16 * 1024 * 1024

export class ByteStream {
  readonly stream: Duplex
  readonly signal: AbortSignal
  private data = Buffer.alloc(0)
  private wake: (() => void) | undefined
  private error: Error | undefined
  constructor(stream: Duplex, signal: AbortSignal) {
    this.stream = stream
    this.signal = signal
    stream.on('data', this.receive)
    stream.once('error', this.fail)
    stream.once('end', this.end)
    stream.once('close', this.end)
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
  }
  private receive = (chunk: Uint8Array): void => {
    if (this.data.length + chunk.length > maximumBytes) {
      this.fail(new Error('Remote response exceeds the proof size limit'))
      return
    }
    this.data = Buffer.concat([this.data, chunk])
    this.wake?.()
  }
  private fail = (error: Error): void => {
    this.error ||= error
    this.wake?.()
    this.stream.destroy()
  }
  private end = (): void => this.fail(new Error('Remote stream closed'))
  private abort = (): void => this.fail(new Error('Connection cancelled'))
  close(): void {
    this.signal.removeEventListener('abort', this.abort)
    this.fail(new Error('Connection closed'))
    this.stream.removeListener('data', this.receive)
  }
  write(bytes: Uint8Array | string): void {
    if (this.error) throw this.error
    if (this.stream.writableLength > maximumBytes)
      throw new Error('Remote output is backlogged')
    this.stream.write(typeof bytes === 'string' ? bytes : Buffer.from(bytes))
  }
  async read(length: number): Promise<Buffer> {
    this.signal.throwIfAborted()
    if (length < 0 || length > maximumBytes)
      throw new Error('Invalid remote frame size')
    while (this.data.length < length) {
      if (this.error) throw this.error
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = undefined
          reject(new Error('Remote response timed out'))
        }, 120_000)
        this.wake = () => {
          clearTimeout(timer)
          this.wake = undefined
          resolve()
        }
      })
    }
    const value = this.data.subarray(0, length)
    this.data = this.data.subarray(length)
    return value
  }
  async line(): Promise<string> {
    const parts: number[] = []
    while (parts.length < 32_768) {
      const byte = (await this.read(1))[0]
      if (byte === 10) return Buffer.from(parts).toString().replace(/\r$/, '')
      parts.push(byte)
    }
    throw new Error('Remote HTTP header is too large')
  }
  async headers(): Promise<{ status: number; headers: Map<string, string> }> {
    const status = Number((await this.line()).split(' ')[1])
    const headers = new Map<string, string>()
    for (let i = 0; i < 100; i++) {
      const line = await this.line()
      if (!line) return { status, headers }
      const separator = line.indexOf(':')
      if (separator < 1) throw new Error('Invalid remote HTTP header')
      headers.set(
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1).trim(),
      )
    }
    throw new Error('Too many remote HTTP headers')
  }
  async body(headers: Map<string, string>): Promise<Buffer> {
    if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
      const parts: Buffer[] = []
      let length = 0
      while (true) {
        const size = Number.parseInt((await this.line()).split(';')[0], 16)
        if (
          !Number.isInteger(size) ||
          size < 0 ||
          (length += size) > maximumBytes
        )
          throw new Error('Invalid HTTP chunk')
        if (!size) {
          while (await this.line()) {
            /* HTTP trailers */
          }
          return Buffer.concat(parts)
        }
        parts.push(await this.read(size))
        if (await this.line()) throw new Error('Invalid HTTP chunk delimiter')
      }
    }
    const length = Number(headers.get('content-length'))
    if (!headers.has('content-length') || !Number.isInteger(length))
      throw new Error('Missing remote response length')
    return this.read(length)
  }
}
