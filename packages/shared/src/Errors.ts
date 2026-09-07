export abstract class CodespacesError extends Error {
  abstract readonly code: string

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export class AccountLookupError extends CodespacesError {
  readonly code = 'E_ACCOUNT_LOOKUP'
}

export class AuthenticationError extends CodespacesError {
  readonly code = 'E_AUTHENTICATION'
}

export class BackendStartupTimeoutError extends CodespacesError {
  readonly code = 'E_BACKEND_STARTUP_TIMEOUT'
}

export class BackendStoppedError extends CodespacesError {
  readonly code = 'E_BACKEND_STOPPED'
}

export class CodespaceRequiredError extends CodespacesError {
  readonly code = 'E_CODESPACE_REQUIRED'
}

export class CodespaceSetupError extends CodespacesError {
  readonly code = 'E_CODESPACE_SETUP'
}

export class CodespaceSetupTimeoutError extends CodespacesError {
  readonly code = 'E_CODESPACE_SETUP_TIMEOUT'
}

export class CodespaceStartupTimeoutError extends CodespacesError {
  readonly code = 'E_CODESPACE_STARTUP_TIMEOUT'
}

export class CodespaceUnavailableError extends CodespacesError {
  readonly code = 'E_CODESPACE_UNAVAILABLE'
}

export class CodespacesRequestError extends CodespacesError {
  readonly code = 'E_CODESPACES_REQUEST'
}

export class CommandFailedError extends CodespacesError {
  readonly code = 'E_COMMAND_FAILED'
}

export class ConnectionCancelledError extends CodespacesError {
  readonly code = 'E_CONNECTION_CANCELLED'
}

export class CrossServerRenameError extends CodespacesError {
  readonly code = 'E_CROSS_SERVER_RENAME'
}

export class DownloadChecksumError extends CodespacesError {
  readonly code = 'E_DOWNLOAD_CHECKSUM'
}

export class DownloadFailedError extends CodespacesError {
  readonly code = 'E_DOWNLOAD_FAILED'
}

export class FileExistsError extends CodespacesError {
  readonly code = 'EEXIST'
}

export class GatewayConnectionError extends CodespacesError {
  readonly code = 'E_GATEWAY_CONNECTION'
}

export class GatewayStartupError extends CodespacesError {
  readonly code = 'E_GATEWAY_STARTUP'
}

export class GatewayUnreachableError extends CodespacesError {
  readonly code = 'E_GATEWAY_UNREACHABLE'
}

export class HttpsRequiredError extends CodespacesError {
  readonly code = 'E_HTTPS_REQUIRED'
}

export class InvalidAccountIdError extends CodespacesError {
  readonly code = 'E_INVALID_ACCOUNT_ID'
}

export class InvalidBackendResponseError extends CodespacesError {
  readonly code = 'E_INVALID_BACKEND_RESPONSE'
}

export class InvalidDirectoryEntriesError extends CodespacesError {
  readonly code = 'E_INVALID_DIRECTORY_ENTRIES'
}

export class InvalidEndpointError extends CodespacesError {
  readonly code = 'E_INVALID_ENDPOINT'
}

export class InvalidFileContentError extends CodespacesError {
  readonly code = 'E_INVALID_FILE_CONTENT'
}

export class InvalidGatewayConnectionError extends CodespacesError {
  readonly code = 'E_INVALID_GATEWAY_CONNECTION'
}

export class InvalidGatewayOptionsError extends CodespacesError {
  readonly code = 'E_INVALID_GATEWAY_OPTIONS'
}

export class InvalidPathError extends CodespacesError {
  readonly code = 'E_INVALID_PATH'
}

export class InvalidRelayAddressError extends CodespacesError {
  readonly code = 'E_INVALID_RELAY_ADDRESS'
}

export class InvalidRemoteUriError extends CodespacesError {
  readonly code = 'E_INVALID_REMOTE_URI'
}

export class InvalidRepositoryError extends CodespacesError {
  readonly code = 'E_INVALID_REPOSITORY'
}

export class InvalidRpcResponseError extends CodespacesError {
  readonly code = 'E_INVALID_RPC_RESPONSE'
}

export class InvalidWebSocketTicketError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_WEBSOCKET_AUTH_INVALID_RESPONSE'
}

export class InvalidWorkspacePathError extends CodespacesError {
  readonly code = 'E_INVALID_WORKSPACE_PATH'
}

export class NoCodespacesError extends CodespacesError {
  readonly code = 'E_NO_CODESPACES'
}

export class OperationInProgressError extends CodespacesError {
  readonly code = 'E_OPERATION_IN_PROGRESS'
}

export class RemoteAuthorityError extends CodespacesError {
  readonly code = 'E_REMOTE_AUTHORITY'
}

export class RemoteConnectionClosedError extends CodespacesError {
  readonly code = 'E_REMOTE_CONNECTION_CLOSED'
}

export class RemoteRequestTimeoutError extends CodespacesError {
  readonly code = 'E_REMOTE_REQUEST_TIMEOUT'
}

export class RemoteRootModificationError extends CodespacesError {
  readonly code = 'E_REMOTE_ROOT_MODIFICATION'
}

export class RemoteServerNotPairedError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_NOT_PAIRED'
}

export class RepositoryListTooLargeError extends CodespacesError {
  readonly code = 'E_REPOSITORY_LIST_TOO_LARGE'
}

export class SetupOwnerRequiredError extends CodespacesError {
  readonly code = 'E_SETUP_OWNER_REQUIRED'
}

export class SignInRequiredError extends CodespacesError {
  readonly code = 'E_SIGN_IN_REQUIRED'
}

export class UnsupportedPlatformError extends CodespacesError {
  readonly code = 'E_UNSUPPORTED_PLATFORM'
}

export class WebSocketAuthHttpError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_WEBSOCKET_AUTH_HTTP_ERROR'
}

export class WebSocketAuthNetworkError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_WEBSOCKET_AUTH_NETWORK_ERROR'
}

export class WebSocketClosedError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_WEBSOCKET_CLOSED'
}

export class WebSocketError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_WEBSOCKET_ERROR'
}

export class WebSocketTimeoutError extends CodespacesError {
  readonly code = 'E_REMOTE_SERVER_WEBSOCKET_TIMEOUT'
}

export class RemoteRequestError extends CodespacesError {
  readonly code: string

  constructor(message: string, code = 'E_REMOTE_REQUEST_FAILED') {
    super(message)
    this.code = code
  }
}
