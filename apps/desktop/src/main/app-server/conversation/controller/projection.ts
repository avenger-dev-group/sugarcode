import type {
  ConversationActivity,
  ConversationContextCompactionActivity,
  ConversationFileChangeActivity,
  ConversationMcpActivity,
  ConversationStateSnapshot,
  ConversationTurn,
} from '@/shared/conversation';

import type { MutableAgentOutput } from '../agent-output-lifecycle';
import type { RecoveredConversation } from '../recovery';
import {
  snapshotThreadNavigator,
  type MutableThreadNavigator,
} from '../thread-navigator';
import type {
  MutableConversationActivity,
  MutableFileChangeActivity,
  MutableMcpActivity,
  MutableTurn,
} from './mutable-state';

export const createMutableTurns = (
  recovered: RecoveredConversation,
): MutableTurn[] =>
  recovered.turns.map((turn) => {
    const activities = (turn.activities ?? []).map(
      toMutableConversationActivity,
    );
    const latestFileChange = [...activities]
      .reverse()
      .find(
        (
          entry,
        ): entry is Extract<
          MutableConversationActivity,
          { type: 'fileChange' }
        > => entry.type === 'fileChange',
      )?.activity;
    const legacyFileChange = latestFileChange ??
      (turn.fileChange
        ? cloneFileChangeActivity(turn.fileChange)
        : undefined);

    return {
      id: turn.id,
      status: turn.status,
      ...(turn.model ? { model: { ...turn.model } } : {}),
      messages: turn.messages.map(({ id, role, text, status }) => ({
        id,
        role,
        text,
        status,
      })),
      pendingAgentOutputs: [] as MutableAgentOutput[],
      activities,
      ...(turn.contextCompactions
        ? {
            contextCompactions: turn.contextCompactions.map((activity) => ({
              ...activity,
              ...(activity.outcome ? { outcome: { ...activity.outcome } } : {}),
            })),
          }
        : {}),
      ...(turn.workspaceRead
        ? {
            workspaceRead: {
              ...turn.workspaceRead,
              ...(turn.workspaceRead.result
                ? {
                    result: {
                      ...turn.workspaceRead.result,
                      outcome: { ...turn.workspaceRead.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceList
        ? {
            workspaceList: {
              ...turn.workspaceList,
              ...(turn.workspaceList.result
                ? {
                    result: {
                      ...turn.workspaceList.result,
                      outcome: { ...turn.workspaceList.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceSearch
        ? {
            workspaceSearch: {
              ...turn.workspaceSearch,
              ...(turn.workspaceSearch.result
                ? {
                    result: {
                      ...turn.workspaceSearch.result,
                      outcome: { ...turn.workspaceSearch.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(legacyFileChange
        ? {
            fileChange: legacyFileChange,
          }
        : {}),
      ...(turn.commandApproval
        ? {
            commandApproval: {
              ...turn.commandApproval,
              ...(turn.commandApproval.decision
                ? { decision: { ...turn.commandApproval.decision } }
                : {}),
              ...(turn.commandApproval.executionAttempt
                ? {
                    executionAttempt: {
                      ...turn.commandApproval.executionAttempt,
                    },
                  }
                : {}),
              ...(turn.commandApproval.executionResult
                ? {
                    executionResult: {
                      ...turn.commandApproval.executionResult,
                      outcome: {
                        ...turn.commandApproval.executionResult.outcome,
                      },
                    },
                  }
                : {}),
              argumentSignature: '',
            },
          }
        : {}),
      ...(turn.mcpActivities
        ? {
            mcpActivities: turn.mcpActivities.map(
              (activity): MutableMcpActivity => ({
                ...activity,
                argumentSignature: '',
                ...(activity.decision
                  ? { decision: { ...activity.decision } }
                  : {}),
                ...(activity.executionAttempt
                  ? { executionAttempt: { ...activity.executionAttempt } }
                  : {}),
                ...(activity.result
                  ? {
                      result: {
                        ...activity.result,
                        receipt: { ...activity.result.receipt },
                      },
                    }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(turn.error ? { error: { ...turn.error } } : {}),
      ...(turn.usage
        ? {
            usage: {
              ...turn.usage,
              lastRequest: { ...turn.usage.lastRequest },
              turnTotal: { ...turn.usage.turnTotal },
            },
          }
        : {}),
    };
  });

type ConversationSnapshotSource = Readonly<{
  revision: number;
  phase: ConversationStateSnapshot['phase'];
  threadId: string | null;
  activeTurnId: string | null;
  turns: readonly MutableTurn[];
  navigator: MutableThreadNavigator;
  activeThreadIds: readonly string[];
  activeThreadTitles: Readonly<Record<string, string>>;
  notice: ConversationStateSnapshot['notice'];
}>;

export const createConversationSnapshot = (
  state: ConversationSnapshotSource,
): ConversationStateSnapshot =>
({
    revision: state.revision,
    phase: state.phase,
    ...(state.threadId ? { threadId: state.threadId } : {}),
    ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
    turns: state.turns.map((turn): ConversationTurn => ({
      id: turn.id,
      status: turn.status,
      ...(turn.model ? { model: { ...turn.model } } : {}),
      messages: turn.messages.map(({ id, role, text, status }) => ({
        id,
        role,
        text,
        status,
      })),
      ...(turn.pendingAgentOutputs.length > 0
        ? {
            pendingAgentOutputs: turn.pendingAgentOutputs.map((output) => ({
              ...output,
            })),
          }
        : {}),
      ...(turn.activities.length > 0
        ? {
            activities: turn.activities.map((activity): ConversationActivity =>
              toConversationActivity(activity),
            ),
          }
        : {}),
      ...(turn.contextCompactions
        ? {
            contextCompactions: turn.contextCompactions.map(
              (activity): ConversationContextCompactionActivity => ({
                ...activity,
                ...(activity.outcome
                  ? { outcome: { ...activity.outcome } }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(turn.workspaceRead
        ? {
            workspaceRead: {
              ...turn.workspaceRead,
              ...(turn.workspaceRead.result
                ? {
                    result: {
                      ...turn.workspaceRead.result,
                      outcome: { ...turn.workspaceRead.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceList
        ? {
            workspaceList: {
              ...turn.workspaceList,
              ...(turn.workspaceList.result
                ? {
                    result: {
                      ...turn.workspaceList.result,
                      outcome: { ...turn.workspaceList.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.workspaceSearch
        ? {
            workspaceSearch: {
              ...turn.workspaceSearch,
              ...(turn.workspaceSearch.result
                ? {
                    result: {
                      ...turn.workspaceSearch.result,
                      outcome: { ...turn.workspaceSearch.result.outcome },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.fileChange
        ? {
            fileChange: cloneFileChangeActivity(turn.fileChange),
          }
        : {}),
      ...(turn.commandApproval
        ? {
            commandApproval: {
              callItemId: turn.commandApproval.callItemId,
              id: turn.commandApproval.id,
              callId: turn.commandApproval.callId,
              approvalId: turn.commandApproval.approvalId,
              command: turn.commandApproval.command,
              argumentCount: turn.commandApproval.argumentCount,
              ...(turn.commandApproval.fullAccess
                ? { fullAccess: true }
                : {}),
              ...(turn.commandApproval.liveOutput
                ? { liveOutput: { ...turn.commandApproval.liveOutput } }
                : {}),
              requestStatus: turn.commandApproval.requestStatus,
              ...(turn.commandApproval.decision
                ? { decision: { ...turn.commandApproval.decision } }
                : {}),
              ...(turn.commandApproval.executionAttempt
                ? {
                    executionAttempt: {
                      ...turn.commandApproval.executionAttempt,
                    },
                  }
                : {}),
              ...(turn.commandApproval.executionResult
                ? {
                    executionResult: {
                      ...turn.commandApproval.executionResult,
                      outcome: {
                        ...turn.commandApproval.executionResult.outcome,
                      },
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(turn.mcpActivities
        ? {
            mcpActivities: turn.mcpActivities.map(
              (activity): ConversationMcpActivity => ({
                callItemId: activity.callItemId,
                id: activity.id,
                callId: activity.callId,
                approvalId: activity.approvalId,
                serverId: activity.serverId,
                name: activity.name,
                argumentsBytes: activity.argumentsBytes,
                argumentsSha256: activity.argumentsSha256,
                inventorySha256: activity.inventorySha256,
                callStatus: activity.callStatus,
                requestStatus: activity.requestStatus,
                ...(activity.decision
                  ? { decision: { ...activity.decision } }
                  : {}),
                ...(activity.executionAttempt
                  ? {
                      executionAttempt: {
                        ...activity.executionAttempt,
                      },
                    }
                  : {}),
                ...(activity.result
                  ? {
                      result: {
                        ...activity.result,
                        receipt: { ...activity.result.receipt },
                      },
                    }
                  : {}),
              }),
            ),
          }
        : {}),
      ...(turn.error ? { error: { ...turn.error } } : {}),
      ...(turn.usage
        ? {
            usage: {
              ...turn.usage,
              lastRequest: { ...turn.usage.lastRequest },
              turnTotal: { ...turn.usage.turnTotal },
            },
          }
        : {}),
    })),
    navigator: snapshotThreadNavigator(
      state.navigator,
      state.activeThreadIds,
      state.activeThreadTitles,
    ),
    ...(state.notice ? { notice: { ...state.notice } } : {}),
  });

const cloneFileChangeActivity = (
  activity: MutableFileChangeActivity | ConversationFileChangeActivity,
): MutableFileChangeActivity => ({
  id: activity.id,
  callId: activity.callId,
  path: activity.path,
  paths: [...(activity.paths ?? [activity.path])],
  callStatus: activity.callStatus,
  changes: (activity.changes ?? (activity.change ? [activity.change] : [])).map(
    (change) => ({ ...change }),
  ),
  ...(activity.change
    ? {
        change: { ...activity.change },
      }
    : {}),
  ...(activity.result
    ? {
        result: {
          ...activity.result,
          outcome: { ...activity.result.outcome },
        },
      }
    : {}),
});

const toConversationActivity = (
  entry: MutableConversationActivity,
): ConversationActivity => {
  switch (entry.type) {
    case 'commentary':
      return {
        type: entry.type,
        activity: { ...entry.activity },
      };
    case 'contextCompaction':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.outcome
            ? { outcome: { ...entry.activity.outcome } }
            : {}),
        },
      };
    case 'workspaceRead':
    case 'workspaceList':
    case 'workspaceSearch':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      } as ConversationActivity;
    case 'fileChange':
      return {
        type: entry.type,
        activity: cloneFileChangeActivity(entry.activity),
      };
    case 'commandApproval': {
      const { argumentSignature, ...activity } = entry.activity;
      void argumentSignature;
      return {
        type: entry.type,
        activity: {
          ...activity,
          ...(activity.decision ? { decision: { ...activity.decision } } : {}),
          ...(activity.executionAttempt
            ? { executionAttempt: { ...activity.executionAttempt } }
            : {}),
          ...(activity.executionResult
            ? {
                executionResult: {
                  ...activity.executionResult,
                  outcome: { ...activity.executionResult.outcome },
                },
              }
            : {}),
        },
      };
    }
    case 'mcp': {
      const { argumentSignature, ...activity } = entry.activity;
      void argumentSignature;
      return {
        type: entry.type,
        activity: {
          ...activity,
          ...(activity.decision ? { decision: { ...activity.decision } } : {}),
          ...(activity.executionAttempt
            ? { executionAttempt: { ...activity.executionAttempt } }
            : {}),
          ...(activity.result
            ? {
                result: {
                  ...activity.result,
                  receipt: { ...activity.result.receipt },
                },
              }
            : {}),
        },
      };
    }
    case 'orchestration':
      return {
        type: entry.type,
        activity: {
          id: entry.activity.id,
          tasks: entry.activity.tasks.map((task) => ({
            ...task,
            dependsOn: [...task.dependsOn],
            amendments: task.amendments.map((amendment) => ({
              ...amendment,
            })),
            ...(task.result ? { result: { ...task.result } } : {}),
          })),
        },
      };
  }
};

const toMutableConversationActivity = (
  entry: ConversationActivity,
): MutableConversationActivity => {
  switch (entry.type) {
    case 'commentary':
      return {
        type: entry.type,
        activity: { ...entry.activity },
      };
    case 'contextCompaction':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.outcome
            ? { outcome: { ...entry.activity.outcome } }
            : {}),
        },
      };
    case 'workspaceRead':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      };
    case 'workspaceList':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      };
    case 'workspaceSearch':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          ...(entry.activity.result
            ? {
                result: {
                  ...entry.activity.result,
                  outcome: { ...entry.activity.result.outcome },
                },
              }
            : {}),
        },
      };
    case 'fileChange':
      return {
        type: entry.type,
        activity: cloneFileChangeActivity(
          entry.activity,
        ) as MutableFileChangeActivity,
      };
    case 'commandApproval':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          argumentSignature: '',
        },
      };
    case 'mcp':
      return {
        type: entry.type,
        activity: {
          ...entry.activity,
          argumentSignature: '',
        },
      };
    case 'orchestration':
      return {
        type: entry.type,
        activity: {
          id: entry.activity.id,
          tasks: entry.activity.tasks.map((task) => ({
            ...task,
            dependsOn: [...task.dependsOn],
            amendments: task.amendments.map((amendment) => ({
              ...amendment,
            })),
            ...(task.result ? { result: { ...task.result } } : {}),
          })),
        },
      };
  }
};
