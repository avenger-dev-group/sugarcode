import { isAbsoluteWorkspaceFileReference } from './workspace-file-reference';

export const WORKSPACE_STATE_GET_CHANNEL = 'workspace-state:get';
export const WORKSPACE_STATE_CHANGED_CHANNEL = 'workspace-state:changed';
export const WORKSPACE_SELECT_CHANNEL = 'workspace:select';
export const WORKSPACE_PROJECT_RESUME_CHANNEL = 'workspace:project-resume';
export const WORKSPACE_PROJECT_ACTIVATE_CHANNEL = 'workspace:project-activate';
export const WORKSPACE_PROJECT_REMOVE_CHANNEL = 'workspace:project-remove';
export const WORKSPACE_TASK_FOCUS_CHANNEL = 'workspace:task-focus';
export const WORKSPACE_TASK_DELETE_CHANNEL = 'workspace:task-delete';
export const WORKSPACE_TASK_RENAME_CHANNEL = 'workspace:task-rename';
export const WORKSPACE_CHAT_ACTIVATE_CHANNEL = 'workspace:chat-activate';
export const WORKSPACE_CLEAR_CHANNEL = 'workspace:clear';
export const WORKSPACE_LIST_CHANNEL = 'workspace:list';
export const WORKSPACE_PATH_SEARCH_CHANNEL = 'workspace:path-search';
export const WORKSPACE_INSPECT_CHANNEL = 'workspace:inspect';
export const WORKSPACE_RESOLVE_CHANNEL = 'workspace:resolve';

export type WorkspaceStatus =
  | 'unselected'
  | 'selecting'
  | 'ready'
  | 'failed';

export type WorkspaceKind = 'project' | 'chat';

export type WorkspaceProjectSummary = Readonly<{
  id: string;
  name: string;
  threadIds: readonly string[];
  threadTitles: Readonly<Record<string, string>>;
  lastOpenedAtMs: number;
}>;

export type WorkspaceStateSnapshot = Readonly<{
  revision: number;
  generation: number;
  status: WorkspaceStatus;
  kind?: WorkspaceKind;
  name?: string;
  projectName?: string;
  projectThreadIds?: readonly string[];
  projects?: readonly WorkspaceProjectSummary[];
  activeProjectId?: string;
  chatThreadIds?: readonly string[];
  chatTitles?: Readonly<Record<string, string>>;
  error?: string;
}>;

export type ForegroundSelection = Readonly<{
  generation: number;
  workspaceId: string;
  threadId: string | null;
}>;

export type ForegroundCommit = Readonly<{
  selection: ForegroundSelection;
  workspace: WorkspaceStateSnapshot;
  thread: ConversationThreadProjectionSnapshot | null;
}>;

export type WorkspaceChatRequest = Readonly<{
  threadId?: string;
}>;

export type WorkspaceTaskRenameRequest = Readonly<{
  threadId: string;
  title: string;
}>;

export type WorkspaceEntryKind =
  | 'file'
  | 'directory'
  | 'link'
  | 'other';

export type WorkspaceEntry = Readonly<{
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
}>;

export type WorkspaceListRequest = Readonly<{
  generation: number;
  path: string;
}>;

export type WorkspaceListResult =
  | Readonly<{
      accepted: true;
      generation: number;
      path: string;
      entries: readonly WorkspaceEntry[];
    }>
  | Readonly<{
      accepted: false;
      reason: 'stale' | 'unavailable' | 'invalid' | 'failed';
    }>;

export type WorkspacePathSearchRequest = Readonly<{
  generation: number;
  query: string;
}>;

export type WorkspacePathSearchResult =
  | Readonly<{
      accepted: true;
      generation: number;
      query: string;
      paths: readonly string[];
      truncated: boolean;
    }>
  | Readonly<{
      accepted: false;
      reason: 'stale' | 'unavailable' | 'invalid' | 'failed';
    }>;

export type WorkspaceInspectRequest = Readonly<{
  generation: number;
  path: string;
}>;

export type WorkspaceInspectDocument =
  | Readonly<{
      status: 'complete';
      path: string;
      content: string;
      bytes: number;
      lines: number;
      hasUtf8Bom: boolean;
    }>
  | Readonly<{
      status: 'truncated';
      path: string;
      content: string;
      bytes: number;
      returnedBytes: number;
      lines: number;
      hasUtf8Bom: boolean;
    }>
  | Readonly<{
      status: 'error';
      path: string;
      kind:
        | 'invalidPath'
        | 'notFound'
        | 'accessDenied'
        | 'pathNotAllowed'
        | 'notRegularFile'
        | 'oversized'
        | 'binary'
        | 'invalidEncoding'
        | 'longLine'
        | 'changed'
        | 'unavailable';
    }>;

export type WorkspaceInspectResult =
  | Readonly<{
      accepted: true;
      generation: number;
      document: WorkspaceInspectDocument;
    }>
  | Readonly<{
      accepted: false;
      reason: 'stale' | 'unavailable' | 'invalid' | 'failed';
    }>;

export type WorkspaceResolveRequest = Readonly<{
  generation: number;
  reference: string;
}>;

export type WorkspaceResolveResult =
  | Readonly<{
      accepted: true;
      generation: number;
      reference: string;
      status:
        | 'resolved'
        | 'notFound'
        | 'ambiguous'
        | 'outsideWorkspace'
        | 'unavailable';
      path?: string;
    }>
  | Readonly<{
      accepted: false;
      reason: 'stale' | 'unavailable' | 'invalid' | 'failed';
    }>;

export type WorkspaceSelectResult = Readonly<{
  accepted: boolean;
  reason?: 'cancelled' | 'busy' | 'invalid' | 'failed';
  commit?: ForegroundCommit;
}>;

export type WorkspaceApi = Readonly<{
  getWorkspaceState: () => Promise<WorkspaceStateSnapshot>;
  onWorkspaceStateChanged: (
    listener: (snapshot: WorkspaceStateSnapshot) => void,
  ) => () => void;
  selectWorkspace: () => Promise<WorkspaceSelectResult>;
  resumeWorkspaceProject: () => Promise<WorkspaceSelectResult>;
  activateWorkspaceProject: (
    projectId: string,
  ) => Promise<WorkspaceSelectResult>;
  removeWorkspaceProject: (
    projectId: string,
  ) => Promise<WorkspaceSelectResult>;
  focusWorkspaceTask: (threadId: string) => Promise<WorkspaceSelectResult>;
  deleteWorkspaceTask: (threadId: string) => Promise<WorkspaceSelectResult>;
  renameWorkspaceTask: (
    request: WorkspaceTaskRenameRequest,
  ) => Promise<WorkspaceSelectResult>;
  activateWorkspaceChat: (
    request: WorkspaceChatRequest,
  ) => Promise<WorkspaceSelectResult>;
  clearWorkspace: () => Promise<WorkspaceSelectResult>;
  listWorkspace: (
    request: WorkspaceListRequest,
  ) => Promise<WorkspaceListResult>;
  searchWorkspacePaths: (
    request: WorkspacePathSearchRequest,
  ) => Promise<WorkspacePathSearchResult>;
  inspectWorkspace: (
    request: WorkspaceInspectRequest,
  ) => Promise<WorkspaceInspectResult>;
  resolveWorkspaceFile: (
    request: WorkspaceResolveRequest,
  ) => Promise<WorkspaceResolveResult>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isSafeRelativePath = (
  value: unknown,
  allowRoot: boolean,
): value is string =>
  typeof value === 'string' &&
  new TextEncoder().encode(value).byteLength <= 1_024 &&
  (allowRoot || value.length > 0) &&
  (value.length === 0 ||
    (!value.startsWith('/') &&
      !value.startsWith('\\') &&
      value.split(/[\\/]/u).length <= 64 &&
      !value
        .split(/[\\/]/u)
        .some(
          (part) =>
            part.length === 0 ||
            part === '.' ||
            part === '..',
        ) &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })));

const isThreadId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );

export const isWorkspaceStateSnapshot = (
  value: unknown,
): value is WorkspaceStateSnapshot =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    'revision',
    'generation',
    'status',
    'kind',
    'name',
    'projectName',
    'projectThreadIds',
    'projects',
    'activeProjectId',
    'chatThreadIds',
    'chatTitles',
    'error',
  ]) &&
  Number.isSafeInteger(value.revision) &&
  (value.revision as number) >= 0 &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  ['unselected', 'selecting', 'ready', 'failed'].includes(
    value.status as string,
  ) &&
  (value.kind === undefined ||
    ['project', 'chat'].includes(value.kind as string)) &&
  (value.name === undefined ||
    (typeof value.name === 'string' && value.name.length > 0)) &&
  (value.projectName === undefined ||
    (typeof value.projectName === 'string' &&
      value.projectName.length > 0)) &&
  (value.projectThreadIds === undefined ||
    (Array.isArray(value.projectThreadIds) &&
      value.projectThreadIds.length <= 1_000 &&
      value.projectThreadIds.every(isThreadId))) &&
  (value.projects === undefined ||
    (Array.isArray(value.projects) &&
      value.projects.length <= 100 &&
      value.projects.every(
        (project) =>
          isRecord(project) &&
          hasOnlyKeys(project, [
            'id',
            'name',
            'threadIds',
            'threadTitles',
            'lastOpenedAtMs',
          ]) &&
          typeof project.id === 'string' &&
          project.id.length > 0 &&
          project.id.length <= 128 &&
          typeof project.name === 'string' &&
          project.name.length > 0 &&
          Array.isArray(project.threadIds) &&
          project.threadIds.length <= 1_000 &&
          project.threadIds.every(isThreadId) &&
          isRecord(project.threadTitles) &&
          Object.entries(project.threadTitles).every(
            ([threadId, title]) =>
              (project.threadIds as unknown[]).includes(threadId) &&
              typeof title === 'string' &&
              title.length > 0,
          ) &&
          Number.isSafeInteger(project.lastOpenedAtMs) &&
          (project.lastOpenedAtMs as number) >= 0,
      ))) &&
  (value.activeProjectId === undefined ||
    (typeof value.activeProjectId === 'string' &&
      value.activeProjectId.length > 0 &&
      value.activeProjectId.length <= 128)) &&
  (value.chatThreadIds === undefined ||
    (Array.isArray(value.chatThreadIds) &&
      value.chatThreadIds.length <= 1_000 &&
      value.chatThreadIds.every(isThreadId))) &&
  (value.chatTitles === undefined ||
    (isRecord(value.chatTitles) &&
      Object.entries(value.chatTitles).every(
        ([threadId, title]) =>
          isThreadId(threadId) &&
          typeof title === 'string' &&
          title.length > 0,
      ))) &&
  (value.error === undefined || typeof value.error === 'string');

export const isWorkspaceChatRequest = (
  value: unknown,
): value is WorkspaceChatRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['threadId']) &&
  (value.threadId === undefined || isThreadId(value.threadId));

export const isWorkspaceTaskRenameRequest = (
  value: unknown,
): value is WorkspaceTaskRenameRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['threadId', 'title']) &&
  isThreadId(value.threadId) &&
  isValidConversationTitle(value.title);

export const isWorkspaceListRequest = (
  value: unknown,
): value is WorkspaceListRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'path']) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  isSafeRelativePath(value.path, true);

export const isWorkspacePathSearchRequest = (
  value: unknown,
): value is WorkspacePathSearchRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'query']) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  typeof value.query === 'string' &&
  value.query.trim().length > 0 &&
  new TextEncoder().encode(value.query).byteLength <= 512 &&
  !/[\r\n]/u.test(value.query);

export const isWorkspaceInspectRequest = (
  value: unknown,
): value is WorkspaceInspectRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'path']) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  isSafeRelativePath(value.path, false);

export const isWorkspaceResolveRequest = (
  value: unknown,
): value is WorkspaceResolveRequest =>
  isRecord(value) &&
  hasOnlyKeys(value, ['generation', 'reference']) &&
  Number.isSafeInteger(value.generation) &&
  (value.generation as number) >= 0 &&
  typeof value.reference === 'string' &&
  value.reference.length > 0 &&
  new TextEncoder().encode(value.reference).byteLength <= 1_024 &&
  !value.reference.includes('://') &&
  !Array.from(value.reference).some((character) => /\p{Cc}/u.test(character)) &&
  (isAbsoluteWorkspaceFileReference(value.reference) ||
    (!value.reference.includes('/') && !value.reference.includes('\\')));

const isForegroundCommit = (value: unknown): value is ForegroundCommit => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['selection', 'workspace', 'thread']) ||
    !isRecord(value.selection) ||
    !hasOnlyKeys(value.selection, [
      'generation',
      'workspaceId',
      'threadId',
    ]) ||
    !Number.isSafeInteger(value.selection.generation) ||
    Number(value.selection.generation) < 1 ||
    typeof value.selection.workspaceId !== 'string' ||
    value.selection.workspaceId.length === 0 ||
    (value.selection.threadId !== null &&
      !isThreadId(value.selection.threadId)) ||
    !isWorkspaceStateSnapshot(value.workspace)
  ) {
    return false;
  }
  const thread = value.thread;
  if (thread !== null && !isConversationThreadProjectionSnapshot(thread)) {
    return false;
  }
  if (thread === null) {
    return value.selection.threadId === null;
  }
  const validThread = thread as ConversationThreadProjectionSnapshot;
  return (
    value.selection.threadId === validThread.threadId &&
    value.selection.workspaceId === validThread.workspaceId
  );
};

export const isWorkspaceSelectResult = (
  value: unknown,
): value is WorkspaceSelectResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ['accepted', 'reason', 'commit']) &&
  typeof value.accepted === 'boolean' &&
  (value.accepted
    ? value.reason === undefined &&
      (value.commit === undefined || isForegroundCommit(value.commit))
    : value.commit === undefined &&
      ['cancelled', 'busy', 'invalid', 'failed'].includes(
        value.reason as string,
      ));

const ENTRY_KINDS = ['file', 'directory', 'link', 'other'];

export const isWorkspaceListResult = (
  value: unknown,
): value is WorkspaceListResult => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') {
    return false;
  }
  if (!value.accepted) {
    return (
      hasOnlyKeys(value, ['accepted', 'reason']) &&
      ['stale', 'unavailable', 'invalid', 'failed'].includes(
        value.reason as string,
      )
    );
  }
  return (
    hasOnlyKeys(value, [
      'accepted',
      'generation',
      'path',
      'entries',
    ]) &&
    Number.isSafeInteger(value.generation) &&
    isSafeRelativePath(value.path, true) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ['name', 'path', 'kind']) &&
        typeof entry.name === 'string' &&
        isSafeRelativePath(entry.path, false) &&
        ENTRY_KINDS.includes(entry.kind as string),
    )
  );
};

export const isWorkspacePathSearchResult = (
  value: unknown,
): value is WorkspacePathSearchResult => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') {
    return false;
  }
  if (!value.accepted) {
    return (
      hasOnlyKeys(value, ['accepted', 'reason']) &&
      ['stale', 'unavailable', 'invalid', 'failed'].includes(
        value.reason as string,
      )
    );
  }
  return (
    hasOnlyKeys(value, [
      'accepted',
      'generation',
      'query',
      'paths',
      'truncated',
    ]) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0 &&
    typeof value.query === 'string' &&
    value.query.trim().length > 0 &&
    new TextEncoder().encode(value.query).byteLength <= 512 &&
    Array.isArray(value.paths) &&
    value.paths.length <= 64 &&
    value.paths.every((path) => isSafeRelativePath(path, false)) &&
    typeof value.truncated === 'boolean'
  );
};

export const isWorkspaceInspectResult = (
  value: unknown,
): value is WorkspaceInspectResult => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') {
    return false;
  }
  if (!value.accepted) {
    return (
      hasOnlyKeys(value, ['accepted', 'reason']) &&
      ['stale', 'unavailable', 'invalid', 'failed'].includes(
        value.reason as string,
      )
    );
  }
  if (
    !(
      hasOnlyKeys(value, ['accepted', 'generation', 'document']) &&
      Number.isSafeInteger(value.generation) &&
      isRecord(value.document) &&
      typeof value.document.status === 'string' &&
      isSafeRelativePath(value.document.path, false)
    )
  ) {
    return false;
  }
  const document = value.document;
  if (document.status === 'error') {
    return (
      hasOnlyKeys(document, ['status', 'path', 'kind']) &&
      [
        'invalidPath',
        'notFound',
        'accessDenied',
        'pathNotAllowed',
        'notRegularFile',
        'oversized',
        'binary',
        'invalidEncoding',
        'longLine',
        'changed',
        'unavailable',
      ].includes(document.kind as string)
    );
  }
  if (document.status === 'complete') {
    return (
      hasOnlyKeys(document, [
        'status',
        'path',
        'content',
        'bytes',
        'lines',
        'hasUtf8Bom',
      ]) &&
      typeof document.content === 'string' &&
      Number.isSafeInteger(document.bytes) &&
      Number.isSafeInteger(document.lines) &&
      typeof document.hasUtf8Bom === 'boolean'
    );
  }
  return (
    document.status === 'truncated' &&
    hasOnlyKeys(document, [
      'status',
      'path',
      'content',
      'bytes',
      'returnedBytes',
      'lines',
      'hasUtf8Bom',
    ]) &&
    typeof document.content === 'string' &&
    Number.isSafeInteger(document.bytes) &&
    Number.isSafeInteger(document.returnedBytes) &&
    Number.isSafeInteger(document.lines) &&
    typeof document.hasUtf8Bom === 'boolean'
  );
};

export const isWorkspaceResolveResult = (
  value: unknown,
): value is WorkspaceResolveResult => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean') {
    return false;
  }
  if (!value.accepted) {
    return (
      hasOnlyKeys(value, ['accepted', 'reason']) &&
      ['stale', 'unavailable', 'invalid', 'failed'].includes(
        value.reason as string,
      )
    );
  }
  return (
    hasOnlyKeys(value, [
      'accepted',
      'generation',
      'reference',
      'status',
      'path',
    ]) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0 &&
    typeof value.reference === 'string' &&
    value.reference.length > 0 &&
    new TextEncoder().encode(value.reference).byteLength <= 1_024 &&
    !value.reference.includes('://') &&
    !Array.from(value.reference).some((character) =>
      /\p{Cc}/u.test(character),
    ) &&
    (isAbsoluteWorkspaceFileReference(value.reference) ||
      (!value.reference.includes('/') && !value.reference.includes('\\'))) &&
    [
      'resolved',
      'notFound',
      'ambiguous',
      'outsideWorkspace',
      'unavailable',
    ].includes(
      value.status as string,
    ) &&
    (value.status === 'resolved'
      ? isSafeRelativePath(value.path, false)
      : value.path === undefined)
  );
};
import {
  isConversationThreadProjectionSnapshot,
  isValidConversationTitle,
  type ConversationThreadProjectionSnapshot,
} from './conversation';
