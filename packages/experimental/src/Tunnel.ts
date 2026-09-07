import { Buffer } from 'buffer'
import { TunnelRelayTunnelClient } from '@microsoft/dev-tunnels-connections'
import { CancellationTokenSource } from '@microsoft/dev-tunnels-ssh'
import type { Tunnel } from '@microsoft/dev-tunnels-contracts'
import { broker } from './Auth.ts'
import { ByteStream } from './Stream.ts'
import { ManagementConnection } from './Protocol.ts'
import { protoString, rpc, startServer } from './Grpc.ts'

interface Descriptor {
  workspacePath: string
  tunnel: Tunnel
}

export const connect = async (
  name: string,
  signal: AbortSignal,
  progress: (message: string) => void,
) => {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name))
    throw new Error('Invalid Codespace name')
  const client = new TunnelRelayTunnelClient()
  client.acceptLocalConnectionsForForwardedPorts = false
  const cancellation = new CancellationTokenSource()
  let management: ManagementConnection | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let heartbeatBusy = false
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    signal.removeEventListener('abort', close)
    // vscode-jsonrpc 3.x dispose() cancels; cancelling twice before the lazy
    // token is read throws. Dispose the source exactly once, including preflight.
    cancellation.dispose()
    management?.close()
    void client.dispose().catch(() => {})
  }
  signal.addEventListener('abort', close, { once: true })
  const openPort = async (port: number): Promise<ByteStream> => {
    signal.throwIfAborted()
    if (closed) throw new Error('Disconnected')
    return new ByteStream(
      await client.connectToForwardedPort(port, cancellation.token),
      signal,
    )
  }
  try {
    signal.throwIfAborted()
    progress('Discovering the private GitHub tunnel…')
    const descriptor = await broker<Descriptor>(
      `/${name}/browser-connection`,
      signal,
    )
    if (
      !descriptor.tunnel?.accessTokens?.connect ||
      !descriptor.tunnel.endpoints?.length
    )
      throw new Error('Invalid tunnel descriptor')
    for (const endpoint of descriptor.tunnel.endpoints) {
      const value = new URL(
        (endpoint as { clientRelayUri?: string }).clientRelayUri || '',
      )
      if (
        value.protocol !== 'wss:' ||
        !/^[a-z0-9-]+\.rel\.tunnels\.api\.visualstudio\.com$/.test(
          value.hostname,
        ) ||
        value.username ||
        value.password ||
        value.port
      )
        throw new Error('Invalid GitHub tunnel endpoint')
    }
    await broker(`/${name}/browser-port`, signal, { port: 16635 })
    progress('Opening the browser WebSocket tunnel…')
    // No management client: all discovery/port registration goes through the
    // narrow broker. Reconnect is explicit so old PTYs cannot receive new input.
    await client.connect(
      descriptor.tunnel,
      { enableReconnect: false, enableRetry: false },
      cancellation.token,
    )
    await client.refreshPorts()
    await client.waitForForwardedPort(16635, cancellation.token)
    progress('Asking the Codespaces agent to start VS Code Server…')
    const server = await startServer(await openPort(16635))
    await broker(`/${name}/browser-port`, signal, { port: server.port })
    await client.refreshPorts()
    await client.waitForForwardedPort(server.port, cancellation.token)
    progress('Authenticating the remote workspace connection…')
    management = new ManagementConnection(await openPort(server.port), name)
    await management.connect(server.port, server.token)
    const activity = async (): Promise<void> => {
      if (closed || heartbeatBusy) return
      heartbeatBusy = true
      try {
        await rpc(
          await openPort(16635),
          'CodespaceHost',
          'NotifyCodespaceOfClientActivity',
          Buffer.concat([
            protoString(1, 'lvce-editor'),
            protoString(2, 'keepAlive'),
          ]),
        )
      } catch {
        if (!closed)
          progress(
            'GitHub activity notification failed; the Codespace idle timeout still applies.',
          )
      } finally {
        heartbeatBusy = false
      }
    }
    heartbeat = setInterval(() => {
      void activity()
    }, 60_000)
    void activity()
    return { management, workspacePath: descriptor.workspacePath, close }
  } catch (error) {
    close()
    throw error
  }
}
