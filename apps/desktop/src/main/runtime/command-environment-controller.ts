import { randomUUID } from 'node:crypto';

import type { RuntimeSupervisor } from './supervisor';
import type {
  CommandEnvironmentActionResult,
  CommandEnvironmentProfileRequest,
  CommandEnvironmentRefreshRequest,
  CommandEnvironmentStatus,
  CommandEnvironmentTarget,
  TaskWorkspaceActionResult,
  TaskWorkspaceRequest,
  TaskWorkspaceSetRequest,
  TaskWorkspaceStatus,
} from '@/shared/command-environment';

export class RuntimeCommandEnvironmentController {
  constructor(private readonly runtime: RuntimeSupervisor) {}

  inspect = async (
    target: CommandEnvironmentTarget,
  ): Promise<CommandEnvironmentStatus> => {
    const event = await this.runtime.request(
      {
        type: 'environment.inspect',
        requestId: randomUUID(),
        workspaceId: target.workspaceId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
      },
      'environment.inspection',
    );
    return event.status;
  };

  refresh = async (
    request: CommandEnvironmentRefreshRequest,
  ): Promise<CommandEnvironmentActionResult> => {
    const event = await this.runtime.request(
      {
        type: 'environment.refresh',
        requestId: randomUUID(),
        workspaceId: request.workspaceId,
        threadId: request.threadId,
      },
      'environment.action',
      15_000,
    );
    return event.action;
  };

  setProfileLoading = async (
    request: CommandEnvironmentProfileRequest,
  ): Promise<CommandEnvironmentActionResult> => {
    const event = await this.runtime.request(
      {
        type: 'environment.profileLoadingSet',
        requestId: randomUUID(),
        enabled: request.enabled,
      },
      'environment.action',
    );
    if (
      !event.action.accepted ||
      !request.workspaceId ||
      !request.threadId
    ) {
      return event.action;
    }
    const refreshed = await this.refresh({
      workspaceId: request.workspaceId,
      threadId: request.threadId,
    });
    return {
      ...refreshed,
      changed: event.action.changed,
    };
  };

  inspectTaskWorkspace = async (
    request: TaskWorkspaceRequest,
  ): Promise<TaskWorkspaceStatus> => {
    const event = await this.runtime.request(
      {
        type: 'taskWorkspace.inspect',
        requestId: randomUUID(),
        workspaceId: request.workspaceId,
        threadId: request.threadId,
      },
      'taskWorkspace.inspection',
    );
    return event.workspace;
  };

  setTaskWorkspace = async (
    request: TaskWorkspaceSetRequest,
  ): Promise<TaskWorkspaceActionResult> => {
    const event = await this.runtime.request(
      {
        type: 'taskWorkspace.set',
        requestId: randomUUID(),
        workspaceId: request.workspaceId,
        threadId: request.threadId,
        mode: request.mode,
      },
      'taskWorkspace.action',
      30_000,
    );
    return event.action;
  };
}
