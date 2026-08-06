import { createRequire } from 'node:module';

export type NativeRuntimeBinding = Readonly<{
  ensureWorkspace: (workspaceId: string, canonicalRoot: string) => void;
  ensureThread: (
    threadId: string,
    workspaceId: string,
    title?: string,
  ) => void;
  startTurn: (
    turnId: string,
    threadId: string,
    requestId: string,
    providerWireApi: string,
    model: string,
  ) => void;
  appendItem: (
    itemId: string,
    turnId: string,
    sequence: number,
    kind: string,
    payloadJson: string,
  ) => boolean;
  finishTurn: (
    turnId: string,
    status: string,
    errorJson?: string,
  ) => boolean;
  loadThreadJson: (threadId: string) => string;
  workspaceRead: (workspaceId: string, path: string) => Promise<string>;
  workspaceList: (workspaceId: string, path: string) => Promise<string>;
  workspaceSearch: (
    workspaceId: string,
    path: string,
    query: string,
  ) => Promise<string>;
}>;

type NativeExports = Readonly<{
  NativeRuntime: new (dataDirectory: string) => NativeRuntimeBinding;
}>;

const require = createRequire(process.execPath);

export const loadNativeRuntime = (
  nativeModulePath: string,
  dataDirectory: string,
): NativeRuntimeBinding => {
  const exports = require(nativeModulePath) as Partial<NativeExports>;
  if (typeof exports.NativeRuntime !== 'function') {
    throw new Error('The SugarCode native module does not export NativeRuntime.');
  }
  return new exports.NativeRuntime(dataDirectory);
};
