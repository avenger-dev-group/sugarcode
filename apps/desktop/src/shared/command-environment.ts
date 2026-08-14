export const COMMAND_ENVIRONMENT_GET_CHANNEL = 'command-environment:get';
export const COMMAND_ENVIRONMENT_REFRESH_CHANNEL = 'command-environment:refresh';
export const COMMAND_ENVIRONMENT_PROFILE_CHANNEL = 'command-environment:profile';
export const TASK_WORKSPACE_GET_CHANNEL = 'task-workspace:get';
export const TASK_WORKSPACE_SET_CHANNEL = 'task-workspace:set';

export type CommandEnvironmentState =
  | 'notCaptured'
  | 'capturing'
  | 'ready'
  | 'degraded'
  | 'failed';

export type CommandEnvironmentStatus = Readonly<{
  snapshotId?: string;
  state: CommandEnvironmentState;
  shell: Readonly<{
    kind: 'zsh' | 'bash' | 'fish' | 'posix' | 'powerShell' | 'cmd';
    executable: string;
  }>;
  source: 'shellProfile' | 'processFallback';
  createdAt?: number;
  pathEntries: readonly string[];
  variableCount: number;
  filteredVariableCount: number;
  profileLoadingEnabled: boolean;
  lastError?: string;
}>;

export type CommandEnvironmentTarget = Readonly<{
  workspaceId: string;
  threadId?: string;
}>;

export type CommandEnvironmentRefreshRequest = Readonly<{
  workspaceId: string;
  threadId: string;
}>;

export type CommandEnvironmentProfileRequest = Readonly<{
  enabled: boolean;
  workspaceId?: string;
  threadId?: string;
}>;

export type CommandEnvironmentActionResult = Readonly<{
  accepted: boolean;
  changed?: boolean;
  status?: CommandEnvironmentStatus;
}>;

export type TaskWorkspaceStatus = Readonly<{
  threadId: string;
  mode: 'local' | 'worktree';
  root: string;
  branch?: string;
}>;

export type TaskWorkspaceRequest = Readonly<{
  workspaceId: string;
  threadId: string;
}>;

export type TaskWorkspaceSetRequest = TaskWorkspaceRequest &
  Readonly<{ mode: 'local' | 'worktree' }>;

export type TaskWorkspaceActionResult = Readonly<{
  accepted: boolean;
  workspace?: TaskWorkspaceStatus;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isCommandEnvironmentStatus = (
  value: unknown,
): value is CommandEnvironmentStatus =>
  isRecord(value) &&
  ['notCaptured', 'capturing', 'ready', 'degraded', 'failed'].includes(
    String(value.state),
  ) &&
  isRecord(value.shell) &&
  ['zsh', 'bash', 'fish', 'posix', 'powerShell', 'cmd'].includes(
    String(value.shell.kind),
  ) &&
  typeof value.shell.executable === 'string' &&
  value.shell.executable.length > 0 &&
  value.shell.executable.length <= 4_096 &&
  ['shellProfile', 'processFallback'].includes(String(value.source)) &&
  (value.snapshotId === undefined ||
    (typeof value.snapshotId === 'string' && value.snapshotId.length <= 256)) &&
  (value.createdAt === undefined || Number.isSafeInteger(value.createdAt)) &&
  Array.isArray(value.pathEntries) &&
  value.pathEntries.length <= 256 &&
  value.pathEntries.every(
    (entry) => typeof entry === 'string' && entry.length <= 32_768,
  ) &&
  value.pathEntries.join('\0').length <= 128 * 1_024 &&
  Number.isSafeInteger(value.variableCount) &&
  Number(value.variableCount) >= 0 &&
  Number(value.variableCount) <= 256 &&
  Number.isSafeInteger(value.filteredVariableCount) &&
  Number(value.filteredVariableCount) >= 0 &&
  typeof value.profileLoadingEnabled === 'boolean' &&
  (value.lastError === undefined ||
    (typeof value.lastError === 'string' && value.lastError.length <= 4_096));

export const isCommandEnvironmentActionResult = (
  value: unknown,
): value is CommandEnvironmentActionResult =>
  isRecord(value) &&
  typeof value.accepted === 'boolean' &&
  (value.changed === undefined || typeof value.changed === 'boolean') &&
  (value.status === undefined || isCommandEnvironmentStatus(value.status));

export const isTaskWorkspaceStatus = (
  value: unknown,
): value is TaskWorkspaceStatus =>
  isRecord(value) &&
  typeof value.threadId === 'string' &&
  value.threadId.length > 0 &&
  (value.mode === 'local' || value.mode === 'worktree') &&
  typeof value.root === 'string' &&
  value.root.length > 0 &&
  value.root.length <= 16_384 &&
  (value.branch === undefined ||
    (typeof value.branch === 'string' && value.branch.length <= 512));

export const isTaskWorkspaceActionResult = (
  value: unknown,
): value is TaskWorkspaceActionResult =>
  isRecord(value) &&
  typeof value.accepted === 'boolean' &&
  (value.workspace === undefined || isTaskWorkspaceStatus(value.workspace));

export type CommandEnvironmentApi = Readonly<{
  getCommandEnvironment: (
    target: CommandEnvironmentTarget,
  ) => Promise<CommandEnvironmentStatus>;
  refreshCommandEnvironment: (
    request: CommandEnvironmentRefreshRequest,
  ) => Promise<CommandEnvironmentActionResult>;
  setCommandEnvironmentProfileLoading: (
    request: CommandEnvironmentProfileRequest,
  ) => Promise<CommandEnvironmentActionResult>;
  getTaskWorkspace: (
    request: TaskWorkspaceRequest,
  ) => Promise<TaskWorkspaceStatus>;
  setTaskWorkspaceMode: (
    request: TaskWorkspaceSetRequest,
  ) => Promise<TaskWorkspaceActionResult>;
}>;
