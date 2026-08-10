import type { ConversationActivity } from '../../shared/conversation.ts';
import type { RuntimeTurnItemRecord } from '../../runtime/protocol.ts';

type ProjectedToolActivity = Extract<
  ConversationActivity,
  { type: 'skill' | 'workspaceRead' | 'workspaceList' | 'workspaceSearch' }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const skillName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.startsWith('$') ? value.slice(1) : value;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) &&
    new TextEncoder().encode(name).byteLength <= 64
    ? name
    : undefined;
};

const toolCallActivities = (
  itemId: string,
  callId: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): readonly ProjectedToolActivity[] => {
  if (name === 'load_skill') {
    const selected = skillName(argumentsValue.name);
    return selected
      ? [{
          type: 'skill',
          activity: {
            id: itemId,
            callId,
            name: selected,
            callStatus: 'inProgress',
          },
        }]
      : [];
  }
  if (name === 'workspace_read') {
    const paths = Array.isArray(argumentsValue.paths)
      ? argumentsValue.paths
          .filter(
            (path): path is string =>
              typeof path === 'string' && path.length > 0,
          )
      : nonEmptyString(argumentsValue.path)
        ? [String(argumentsValue.path)]
        : [];
    return paths.map((path, index) => ({
      type: 'workspaceRead',
      activity: {
        id: paths.length === 1 ? itemId : `${itemId}:${index}`,
        callId,
        path,
        callStatus: 'inProgress',
      },
    }));
  }
  if (name === 'workspace_list') {
    const path = nonEmptyString(argumentsValue.path);
    return path
      ? [{
          type: 'workspaceList',
          activity: {
            id: itemId,
            callId,
            path,
            callStatus: 'inProgress',
          },
        }]
      : [];
  }
  if (name === 'workspace_search') {
    const path = nonEmptyString(argumentsValue.path);
    const query = nonEmptyString(argumentsValue.query);
    return path && query
      ? [{
          type: 'workspaceSearch',
          activity: {
            id: itemId,
            callId,
            path,
            query,
            callStatus: 'inProgress',
          },
        }]
      : [];
  }
  return [];
};

export const appendToolCallActivity = (
  activities: ConversationActivity[],
  itemId: string,
  callId: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): void => {
  for (const projected of toolCallActivities(
    itemId,
    callId,
    name,
    argumentsValue,
  )) {
    const duplicate = activities.some((activity) => {
      if (
        !('callId' in activity.activity) ||
        activity.activity.callId !== projected.activity.callId
      ) {
        return false;
      }
      switch (projected.type) {
        case 'skill':
          return (
            activity.type === 'skill' &&
            activity.activity.name === projected.activity.name
          );
        case 'workspaceRead':
        case 'workspaceList':
        case 'workspaceSearch':
          return (
            activity.type === projected.type &&
            activity.activity.path === projected.activity.path
          );
      }
    });
    if (!duplicate) {
      activities.push(projected);
    }
  }
};

const errorKind = (result: Readonly<Record<string, unknown>>): string => {
  if (typeof result.error === 'string' && result.error.length > 0) {
    return result.error;
  }
  if (isRecord(result.error) && typeof result.error.kind === 'string') {
    return result.error.kind;
  }
  if (typeof result.kind === 'string' && result.kind.length > 0) {
    return result.kind;
  }
  return 'invalidToolResult';
};

const completedResultId = (itemId: string, activityId: string): string =>
  itemId === activityId ? `${itemId}:result` : `${itemId}:result:${activityId}`;

export const applyToolResultActivity = (
  activities: ConversationActivity[],
  itemId: string,
  callId: string,
  result: Readonly<Record<string, unknown>>,
): void => {
  const matchingIndexes = activities.flatMap((activity, index) =>
    (activity.type === 'skill' ||
      activity.type === 'workspaceRead' ||
      activity.type === 'workspaceList' ||
      activity.type === 'workspaceSearch') &&
    activity.activity.callId === callId
      ? [index]
      : [],
  );
  const batchFiles = Array.isArray(result.files)
    ? result.files.filter(isRecord)
    : [];

  matchingIndexes.forEach((activityIndex, matchingIndex) => {
    const entry = activities[activityIndex];
    if (
      entry?.type !== 'skill' &&
      entry?.type !== 'workspaceRead' &&
      entry?.type !== 'workspaceList' &&
      entry?.type !== 'workspaceSearch'
    ) {
      return;
    }
    const activityResult = entry.type === 'workspaceRead' && batchFiles.length > 0
      ? batchFiles.find((file) => file.path === entry.activity.path) ??
        batchFiles[matchingIndex] ??
        result
      : result;
    const resultId = completedResultId(itemId, entry.activity.id);
    if (entry.type === 'skill') {
      const outcome = activityResult.ok === true
        ? { type: 'success' as const }
        : { type: 'error' as const, kind: errorKind(activityResult) };
      activities[activityIndex] = {
        type: entry.type,
        activity: {
          ...entry.activity,
          callStatus: 'completed',
          result: { id: resultId, status: 'completed', outcome },
        },
      };
      return;
    }
    if (entry.type === 'workspaceRead') {
      const outcome = activityResult.ok === true &&
          Number.isSafeInteger(activityResult.bytes) &&
          (activityResult.bytes as number) >= 0
        ? { type: 'success' as const, bytes: activityResult.bytes as number }
        : { type: 'error' as const, kind: errorKind(activityResult) };
      activities[activityIndex] = {
        type: entry.type,
        activity: {
          ...entry.activity,
          callStatus: 'completed',
          result: { id: resultId, status: 'completed', outcome },
        },
      };
      return;
    }
    if (entry.type === 'workspaceList') {
      const outcome = activityResult.ok === true && Array.isArray(activityResult.entries)
        ? { type: 'success' as const, entries: activityResult.entries.length }
        : { type: 'error' as const, kind: errorKind(activityResult) };
      activities[activityIndex] = {
        type: entry.type,
        activity: {
          ...entry.activity,
          callStatus: 'completed',
          result: { id: resultId, status: 'completed', outcome },
        },
      };
      return;
    }
    const outcome = activityResult.ok === true && Array.isArray(activityResult.matches)
      ? {
          type: 'success' as const,
          matches: activityResult.matches.length,
          truncated: activityResult.truncated === true,
        }
      : { type: 'error' as const, kind: errorKind(activityResult) };
    activities[activityIndex] = {
      type: entry.type,
      activity: {
        ...entry.activity,
        callStatus: 'completed',
        result: { id: resultId, status: 'completed', outcome },
      },
    };
  });
};

export const projectTurnActivities = (
  items: readonly RuntimeTurnItemRecord[],
): ConversationActivity[] => {
  const activities: ConversationActivity[] = [];
  const orderedItems = [...items].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const hasCompletedCommentary = orderedItems.some(
    (item) =>
      item.kind === 'turn.textCompleted' &&
      item.payload.phase === 'commentary',
  );
  const fallbackCommentary = new Map<
    string,
    { firstSequence: number; text: string }
  >();
  if (!hasCompletedCommentary) {
    for (const item of orderedItems) {
      if (
        item.kind !== 'turn.textDelta' ||
        item.payload.phase !== 'commentary' ||
        typeof item.payload.delta !== 'string'
      ) {
        continue;
      }
      const id = nonEmptyString(item.payload.itemId) ?? `${item.turnId}:commentary`;
      const current = fallbackCommentary.get(id);
      fallbackCommentary.set(id, {
        firstSequence: current?.firstSequence ?? item.sequence,
        text: `${current?.text ?? ''}${item.payload.delta}`,
      });
    }
  }

  for (const item of orderedItems) {
    for (const [id, commentary] of fallbackCommentary) {
      if (
        commentary.firstSequence === item.sequence &&
        !activities.some(
          (activity) =>
            activity.type === 'commentary' && activity.activity.id === id,
        )
      ) {
        activities.push({
          type: 'commentary',
          activity: { id, text: commentary.text, status: 'completed' },
        });
      }
    }
    if (
      item.kind === 'turn.textCompleted' &&
      item.payload.phase === 'commentary'
    ) {
      const id = nonEmptyString(item.payload.itemId) ?? item.id;
      if (
        !activities.some(
          (activity) =>
            activity.type === 'commentary' && activity.activity.id === id,
        )
      ) {
        activities.push({
          type: 'commentary',
          activity: {
            id,
            text: String(item.payload.text ?? ''),
            status: 'completed',
          },
        });
      }
      continue;
    }
    if (
      item.kind === 'turn.toolCall' &&
      typeof item.payload.itemId === 'string' &&
      typeof item.payload.callId === 'string' &&
      typeof item.payload.name === 'string' &&
      isRecord(item.payload.arguments)
    ) {
      appendToolCallActivity(
        activities,
        item.payload.itemId,
        item.payload.callId,
        item.payload.name,
        item.payload.arguments,
      );
      continue;
    }
    if (
      item.kind === 'turn.toolResult' &&
      typeof item.payload.itemId === 'string' &&
      typeof item.payload.callId === 'string' &&
      isRecord(item.payload.result)
    ) {
      applyToolResultActivity(
        activities,
        item.payload.itemId,
        item.payload.callId,
        item.payload.result,
      );
    }
  }
  return activities;
};
