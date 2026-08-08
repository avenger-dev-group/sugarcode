import { createRequire } from 'node:module';

export type NativeRuntimeBinding = Readonly<{
  inspectMcpConfigJson: () => string;
  saveMcpConfigJson: (expectedRevision: string, serversJson: string) => string;
  importAssetJson: (
    fileName: string,
    mediaType: string | undefined,
    data: string,
  ) => string;
  readAssetJson: (assetId: string) => string;
  executeCommandJson: (
    operationId: string,
    workspaceId: string,
    mode: 'sandboxed' | 'fullAccess',
    command: string,
    argumentsJson: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<string>;
  drainCommandOutputJson: (operationId: string) => string;
  finishCommandOutput: (operationId: string) => void;
  createTerminalJson: (
    sessionId: string,
    workspaceId: string,
    columns: number,
    rows: number,
  ) => string;
  terminalInput: (sessionId: string, data: string) => void;
  terminalResize: (sessionId: string, columns: number, rows: number) => void;
  terminalTerminate: (sessionId: string) => void;
  drainTerminalEventsJson: (sessionId: string) => string;
  closeTerminal: (sessionId: string) => boolean;
  cancelOperation: (operationId: string) => boolean;
  ensureWorkspace: (workspaceId: string, canonicalRoot: string) => void;
  ensureThread: (
    threadId: string,
    workspaceId: string,
    title?: string,
  ) => void;
  createThreadJson: (workspaceId: string, title?: string) => string;
  listThreadsJson: (workspaceId: string, query?: string) => string;
  setThreadArchivedJson: (
    threadId: string,
    workspaceId: string,
    archived: boolean,
  ) => string;
  deleteThread: (threadId: string, workspaceId: string) => boolean;
  forkThreadJson: (threadId: string, workspaceId: string) => string;
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
  createAgentTasksJson: (turnId: string, tasksJson: string) => string;
  updateAgentTask: (
    taskId: string,
    status: string,
    payloadJson: string,
  ) => boolean;
  proposeOperation: (
    operationId: string,
    approvalId: string,
    turnId: string,
    toolName: string,
    requestHash: string,
    argumentsJson: string,
    approvalPayloadJson: string,
  ) => boolean;
  listPendingApprovalsJson: () => string;
  resolveApproval: (approvalId: string, decision: 'approved' | 'denied') => boolean;
  completeOperation: (
    operationId: string,
    resultJson: string,
    succeeded: boolean,
  ) => boolean;
  loadThreadJson: (threadId: string) => string;
  workspaceRead: (workspaceId: string, path: string) => Promise<string>;
  workspaceList: (workspaceId: string, path: string) => Promise<string>;
  workspaceInspectJson: (workspaceId: string, path: string) => string;
  workspaceResolveJson: (workspaceId: string, name: string) => Promise<string>;
  workspaceSearch: (
    workspaceId: string,
    path: string,
    query: string,
  ) => Promise<string>;
  workspaceApplyPatch: (workspaceId: string, patch: string) => Promise<string>;
  gitStatusJson: (workspaceId: string) => string;
  gitDiffJson: (
    workspaceId: string,
    expectedRevision: string,
    path: string,
    source: 'worktree' | 'index',
  ) => string;
  gitMutateJson: (
    workspaceId: string,
    expectedRevision: string,
    paths: readonly string[],
    stage: boolean,
  ) => string;
  gitCommitJson: (
    workspaceId: string,
    expectedRevision: string,
    message: string,
    authorName: string,
    authorEmail: string,
  ) => string;
  inspectModelConfigJson: () => string;
  saveModelConfigJson: (
    expectedRevision: string,
    configJson: string,
    credentialUpdatesJson: string,
  ) => string;
  deleteModelApiKeyJson: (
    connectionId: string,
    expectedRevision: string,
  ) => string;
  modelConnectionJson: (connectionId: string) => string;
  modelProfileJson: (profileId?: string) => string;
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
