import type {
  InitializeResponse,
  JsonValue,
  RequestId,
} from '@sugarcode/app-server-protocol';
import { JSON_RPC_VERSION } from '@sugarcode/app-server-protocol';

type JsonRpcResult = Readonly<{
  kind: 'result';
  id: RequestId;
  result: unknown;
}>;

type JsonRpcError = Readonly<{
  kind: 'error';
  id: RequestId | null;
  error: Readonly<{
    code: number;
    message: string;
    data?: JsonValue;
  }>;
}>;

type JsonRpcNotification = Readonly<{
  kind: 'notification';
  method: string;
  params?: unknown;
}>;

type JsonRpcRequest = Readonly<{
  kind: 'request';
  id: RequestId;
  method: string;
  params?: unknown;
}>;

export type ServerMessage =
  | JsonRpcResult
  | JsonRpcError
  | JsonRpcNotification
  | JsonRpcRequest;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isSafeInteger(value));

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
};

const parseErrorObject = (
  value: unknown,
): JsonRpcError['error'] | null => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['code', 'message'], ['data']) ||
    typeof value.code !== 'number' ||
    !Number.isInteger(value.code) ||
    value.code < -2_147_483_648 ||
    value.code > 2_147_483_647 ||
    typeof value.message !== 'string' ||
    (Object.hasOwn(value, 'data') && !isJsonValue(value.data))
  ) {
    return null;
  }

  return Object.hasOwn(value, 'data')
    ? { code: value.code, message: value.message, data: value.data as JsonValue }
    : { code: value.code, message: value.message };
};

export const parseServerMessage = (value: unknown): ServerMessage => {
  if (
    !isRecord(value) ||
    value.jsonrpc !== JSON_RPC_VERSION
  ) {
    throw new Error('Invalid JSON-RPC envelope.');
  }

  if (Object.hasOwn(value, 'method')) {
    if (
      typeof value.method !== 'string' ||
      value.method.length === 0
    ) {
      throw new Error('Invalid JSON-RPC method.');
    }

    if (Object.hasOwn(value, 'id')) {
      if (
        !hasOnlyKeys(value, ['jsonrpc', 'id', 'method'], ['params']) ||
        !isRequestId(value.id) ||
        (Object.hasOwn(value, 'params') && !isJsonValue(value.params))
      ) {
        throw new Error('Invalid JSON-RPC request.');
      }
      return Object.hasOwn(value, 'params')
        ? {
            kind: 'request',
            id: value.id,
            method: value.method,
            params: value.params,
          }
        : { kind: 'request', id: value.id, method: value.method };
    }

    if (
      !hasOnlyKeys(value, ['jsonrpc', 'method'], ['params']) ||
      (Object.hasOwn(value, 'params') && !isJsonValue(value.params))
    ) {
      throw new Error('Invalid JSON-RPC notification.');
    }
    return Object.hasOwn(value, 'params')
      ? { kind: 'notification', method: value.method, params: value.params }
      : { kind: 'notification', method: value.method };
  }

  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasResult === hasError) {
    throw new Error('JSON-RPC response must contain result or error.');
  }

  if (hasResult) {
    if (
      !hasOnlyKeys(value, ['jsonrpc', 'id', 'result']) ||
      !isRequestId(value.id) ||
      !isJsonValue(value.result)
    ) {
      throw new Error('Invalid JSON-RPC result.');
    }
    return { kind: 'result', id: value.id, result: value.result };
  }

  const error = parseErrorObject(value.error);
  if (
    !hasOnlyKeys(value, ['jsonrpc', 'id', 'error']) ||
    (value.id !== null && !isRequestId(value.id)) ||
    !error
  ) {
    throw new Error('Invalid JSON-RPC error.');
  }
  return { kind: 'error', id: value.id as RequestId | null, error };
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const parseInitializeResponse = (
  value: unknown,
): InitializeResponse => {
  if (
    !isRecord(value) ||
    typeof value.protocolVersion !== 'number' ||
    !Number.isInteger(value.protocolVersion) ||
    value.protocolVersion < 0 ||
    !isRecord(value.serverInfo) ||
    !isNonEmptyString(value.serverInfo.name) ||
    !isNonEmptyString(value.serverInfo.version) ||
    !isRecord(value.platform) ||
    !isNonEmptyString(value.platform.family) ||
    !isNonEmptyString(value.platform.os) ||
    !isNonEmptyString(value.platform.arch) ||
    !isRecord(value.capabilities) ||
    typeof value.capabilities.commandApprovals !== 'boolean' ||
    typeof value.capabilities.commandWorkspaceWriteApprovals !==
      'boolean' ||
    (value.capabilities.mcpToolCallApprovals !== undefined &&
      typeof value.capabilities.mcpToolCallApprovals !== 'boolean')
  ) {
    throw new Error('Invalid initialize response.');
  }

  return {
    protocolVersion: value.protocolVersion,
    serverInfo: {
      name: value.serverInfo.name,
      version: value.serverInfo.version,
    },
    platform: {
      family: value.platform.family,
      os: value.platform.os,
      arch: value.platform.arch,
    },
    capabilities: {
      commandApprovals: value.capabilities.commandApprovals,
      commandWorkspaceWriteApprovals:
        value.capabilities.commandWorkspaceWriteApprovals,
      ...(value.capabilities.mcpToolCallApprovals !== undefined
        ? {
            mcpToolCallApprovals:
              value.capabilities.mcpToolCallApprovals as boolean,
          }
        : {}),
    },
  };
};
