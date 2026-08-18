import { createRequire } from 'node:module';

export type NativeRuntimeBinding = Readonly<{
  setKnowledgeAgentActive?: (active: boolean) => void;
  inspectMcpConfigJson: () => string;
  inspectSkillsJson: (workspaceId?: string) => string;
  skillsContextJson: (workspaceId: string) => string;
  readSkillContentJson: (
    workspaceId: string | undefined,
    skillId: string,
    expectedSha256: string,
  ) => string;
  setSkillEnabledJson: (
    workspaceId: string | undefined,
    skillId: string,
    enabled: boolean,
  ) => string;
  recordSkillMarketInstallJson?: (
    workspaceId: string | undefined,
    skillId: string,
    catalogId: string,
    version: string,
    installedSha256: string,
    directorySha256: string,
  ) => string;
  importSkillJson: (
    workspaceId: string | undefined,
    sourcePath: string,
    scope: 'user' | 'project',
  ) => string;
  exportSkillJson: (
    workspaceId: string | undefined,
    skillId: string,
    destinationPath: string,
  ) => string;
  importSkillZipJson?: (
    workspaceId: string | undefined,
    archivePath: string,
    scope: 'user' | 'project',
  ) => string;
  exportSkillZipJson?: (
    workspaceId: string | undefined,
    skillId: string,
    destinationPath: string,
  ) => string;
  inspectKnowledgeJson?: (workspaceId?: string) => string;
  createKnowledgeBaseJson?: (
    name: string,
    description: string,
    workspaceIdsJson: string,
  ) => string;
  updateKnowledgeBaseJson?: (
    knowledgeBaseId: string,
    name: string,
    description: string,
    workspaceIdsJson: string,
    ignoreRulesJson: string,
    semanticEnabled?: boolean,
  ) => string;
  deleteKnowledgeBaseJson?: (knowledgeBaseId: string) => string;
  addKnowledgeFilesJson?: (
    knowledgeBaseId: string,
    pathsJson: string,
  ) => Promise<string>;
  createKnowledgeTextDocumentJson?: (
    knowledgeBaseId: string,
    fileName: string,
    content: string,
  ) => Promise<string>;
  readKnowledgeTextDocumentJson?: (sourceId: string) => string;
  updateKnowledgeTextDocumentJson?: (
    sourceId: string,
    expectedSha256: string,
    content: string,
  ) => Promise<string>;
  addKnowledgeFolderJson?: (
    knowledgeBaseId: string,
    path: string,
  ) => Promise<string>;
  rescanKnowledgeSourceJson?: (sourceId: string, rebuild?: boolean) => Promise<string>;
  cancelKnowledgeIndexJobJson?: (jobId: string) => string;
  deleteKnowledgeSourceJson?: (sourceId: string) => string;
  inspectKnowledgeBaseJson?: (knowledgeBaseId: string) => string;
  searchKnowledgeJson?: (
    workspaceId: string | undefined,
    knowledgeBaseIdsJson: string,
    query: string,
  ) => Promise<string>;
  readKnowledgeJson?: (
    workspaceId: string | undefined,
    knowledgeBaseIdsJson: string,
    documentId: string,
    startOrdinal: number,
  ) => string;
  installSemanticModelJson?: () => Promise<string>;
  cancelSemanticModelDownloadJson?: () => string;
  removeSemanticModelJson?: () => string;
  selectKnowledgeRetrievalPlanJson?: (planId: string) => string;
  setSemanticIndexPausedJson?: (paused: boolean) => string;
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
    threadId: string,
    mode: 'sandboxed' | 'fullAccess',
    command: string,
    argumentsJson: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<string>;
  inspectCommandEnvironmentJson: (
    workspaceId: string,
    threadId?: string,
  ) => string;
  refreshCommandEnvironmentJson: (
    workspaceId: string,
    threadId: string,
  ) => Promise<string>;
  setCommandProfileLoadingEnabledJson: (enabled: boolean) => string;
  inspectProjectEnvironmentJson: (
    workspaceId: string,
    threadId?: string,
  ) => Promise<string>;
  trustProjectEnvironmentJson: (
    workspaceId: string,
    expectedHash: string,
    threadId?: string,
  ) => Promise<string>;
  runProjectEnvironmentActionJson: (
    workspaceId: string,
    threadId: string,
    actionId: string,
  ) => Promise<string>;
  inspectTaskWorkspaceJson: (workspaceId: string, threadId: string) => string;
  taskWorkspaceBindingId: (workspaceId: string, threadId: string) => string;
  setTaskWorkspaceModeJson: (
    workspaceId: string,
    threadId: string,
    mode: 'local' | 'worktree',
  ) => string;
  drainCommandOutputJson: (operationId: string) => string;
  finishCommandOutput: (operationId: string) => void;
  createTerminalJson: (
    sessionId: string,
    workspaceId: string,
    threadId: string | undefined,
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
  workspaceInstructionsJson: (
    workspaceId: string,
    scopesJson: string,
  ) => string;
  ensureThread: (
    threadId: string,
    workspaceId: string,
    title?: string,
  ) => void;
  createThreadJson: (workspaceId: string, title?: string) => string;
  updateThreadTitleJson: (
    threadId: string,
    workspaceId: string,
    title: string,
    onlyIfUnset: boolean,
  ) => string;
  listThreadsJson: (workspaceId: string, query?: string) => string;
  deleteThread: (threadId: string, workspaceId: string) => boolean;
  startTurn: (
    turnId: string,
    threadId: string,
    requestId: string,
    providerWireApi: string,
    model: string,
  ) => void;
  replaceLatestTurnWithUserMessage?: (
    replacedTurnId: string,
    turnId: string,
    threadId: string,
    requestId: string,
    providerWireApi: string,
    model: string,
    userContentJson: string,
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
  createQueuedMessageJson?: (
    threadId: string,
    messageId: string,
    contentJson: string,
    modelProfileId?: string,
  ) => string;
  updateQueuedMessageJson?: (
    threadId: string,
    messageId: string,
    expectedRevision: number,
    contentJson: string,
    modelProfileId?: string,
  ) => string;
  deleteQueuedMessageJson?: (
    threadId: string,
    messageId: string,
    expectedRevision: number,
  ) => string;
  setQueuePausedJson?: (threadId: string, paused: boolean) => string;
  promoteQueuedMessageJson?: (
    threadId: string,
    messageId: string,
    expectedRevision: number,
    turnId: string,
    requestId: string,
    providerWireApi: string,
    model: string,
  ) => string;
  steerQueuedMessageJson?: (
    threadId: string,
    messageId: string,
    expectedRevision: number,
    turnId: string,
    itemId: string,
    sequence: number,
  ) => string;
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
  workspacePathSearchJson: (
    workspaceId: string,
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
