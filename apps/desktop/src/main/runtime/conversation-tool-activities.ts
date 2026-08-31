import type {
  ConversationActivity,
  ConversationKnowledgeCitation,
  ConversationUserInputDecision,
  ConversationUserInputQuestion,
  ConversationUserInputSubmission,
} from '../../shared/conversation.ts';
import { isTrustedCommentaryId } from '../../shared/conversation/trusted-commentary.ts';
import type {
  RuntimeTurnItemRecord,
  RuntimeUserInputQuestion,
  RuntimeUserInputSubmission,
} from '../../runtime/protocol.ts';

type ProjectedToolActivity = Extract<
  ConversationActivity,
  {
    type:
      | 'skill'
      | 'workspaceRead'
      | 'workspaceList'
      | 'workspaceSearch'
      | 'knowledge';
  }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const userInputQuestions = (
  value: unknown,
): readonly ConversationUserInputQuestion[] | undefined => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    return undefined;
  }
  const questions = value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.header !== 'string' ||
      typeof candidate.question !== 'string' ||
      !Array.isArray(candidate.options)
    ) {
      return [];
    }
    const options = candidate.options.flatMap((option) =>
      isRecord(option) &&
        typeof option.label === 'string' &&
        typeof option.description === 'string'
        ? [{ label: option.label, description: option.description }]
        : [],
    );
    return options.length === candidate.options.length
      ? [{
          id: candidate.id,
          header: candidate.header,
          question: candidate.question,
          options,
        }]
      : [];
  });
  return questions.length === value.length ? questions : undefined;
};

const userInputDecision = (
  value: unknown,
  question: ConversationUserInputQuestion | undefined,
): ConversationUserInputDecision | undefined => {
  if (!isRecord(value) || typeof value.questionId !== 'string' || !question) {
    return undefined;
  }
  if (value.kind === 'skipped') {
    return { questionId: value.questionId, kind: 'skipped' };
  }
  if (
    value.kind === 'answered' &&
    (value.source === 'option' || value.source === 'custom') &&
    typeof value.answer === 'string'
  ) {
    return {
      questionId: value.questionId,
      kind: 'answered',
      source: value.source,
      answer: value.answer,
    };
  }
  if (typeof value.answer === 'string') {
    return {
      questionId: value.questionId,
      kind: 'answered',
      source: question.options.some((option) => option.label === value.answer)
        ? 'option'
        : 'custom',
      answer: value.answer,
    };
  }
  return undefined;
};

const userInputSubmission = (
  payload: Readonly<Record<string, unknown>>,
  questions: readonly ConversationUserInputQuestion[],
): ConversationUserInputSubmission | undefined => {
  const rawSubmission = isRecord(payload.submission)
    ? payload.submission
    : undefined;
  const kind = rawSubmission?.kind === 'cancelled'
    ? 'cancelled' as const
    : rawSubmission?.kind === 'submitted' || Array.isArray(payload.answers)
      ? 'submitted' as const
      : undefined;
  const rawDecisions = rawSubmission && Array.isArray(rawSubmission.decisions)
    ? rawSubmission.decisions
    : Array.isArray(payload.answers)
      ? payload.answers
      : undefined;
  if (!kind || !rawDecisions) {
    return undefined;
  }
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const decisions = rawDecisions.flatMap((candidate) => {
    const questionId = isRecord(candidate) && typeof candidate.questionId === 'string'
      ? candidate.questionId
      : undefined;
    const decision = questionId
      ? userInputDecision(candidate, questionById.get(questionId))
      : undefined;
    return decision ? [decision] : [];
  });
  return decisions.length === rawDecisions.length ? { kind, decisions } : undefined;
};

export const appendUserInputActivity = (
  activities: ConversationActivity[],
  inputRequestId: string,
  questions: readonly RuntimeUserInputQuestion[],
): void => {
  if (
    activities.some(
      (entry) =>
        entry.type === 'userInput' && entry.activity.id === inputRequestId,
    )
  ) {
    return;
  }
  activities.push({
    type: 'userInput',
    activity: {
      id: inputRequestId,
      questions,
      state: 'awaiting',
      decisions: [],
    },
  });
};

export const resolveUserInputActivity = (
  activities: ConversationActivity[],
  inputRequestId: string,
  submission: RuntimeUserInputSubmission,
): void => {
  const index = activities.findIndex(
    (entry) =>
      entry.type === 'userInput' && entry.activity.id === inputRequestId,
  );
  const entry = activities[index];
  if (index < 0 || entry?.type !== 'userInput') {
    return;
  }
  activities[index] = {
    type: 'userInput',
    activity: {
      ...entry.activity,
      state: submission.kind,
      decisions: submission.decisions,
    },
  };
};

export const interruptPendingUserInputActivities = (
  activities: readonly ConversationActivity[],
): ConversationActivity[] =>
  activities.map((entry) =>
    entry.type === 'userInput' && entry.activity.state === 'awaiting'
      ? {
          type: 'userInput' as const,
          activity: { ...entry.activity, state: 'interrupted' as const },
        }
      : entry,
  );

const skillName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  const name = (trimmed.startsWith('$') ? trimmed.slice(1) : trimmed)
    .toLowerCase();
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
    const purpose = nonEmptyString(argumentsValue.purpose);
    return selected
      ? [{
          type: 'skill',
          activity: {
            id: itemId,
            callId,
            name: selected,
            ...(purpose && new TextEncoder().encode(purpose).byteLength <= 512
              ? { purpose }
              : {}),
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
  if (
    name === 'knowledge_search' ||
    name === 'knowledge_list_documents' ||
    name === 'knowledge_read'
  ) {
    const operation = name === 'knowledge_search'
      ? 'search' as const
      : name === 'knowledge_list_documents'
        ? 'listDocuments' as const
        : 'read' as const;
    const query = operation === 'search'
      ? nonEmptyString(argumentsValue.query)
      : undefined;
    return [{
      type: 'knowledge',
      activity: {
        id: itemId,
        callId,
        operation,
        ...(query ? { query } : {}),
        callStatus: 'inProgress',
      },
    }];
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
    if (projected.type === 'skill') {
      const existingIndex = activities.findIndex(
        (activity) =>
          activity.type === 'skill' &&
          activity.activity.name === projected.activity.name,
      );
      if (existingIndex >= 0) {
        activities[existingIndex] = projected;
        continue;
      }
    }
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
        case 'knowledge':
          return (
            activity.type === projected.type &&
            activity.activity.operation === projected.activity.operation
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
      activity.type === 'workspaceSearch' ||
      activity.type === 'knowledge') &&
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
      entry?.type !== 'workspaceSearch' &&
      entry?.type !== 'knowledge'
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
      const purpose = nonEmptyString(activityResult.purpose) ??
        entry.activity.purpose;
      const description = nonEmptyString(activityResult.description);
      const content = nonEmptyString(activityResult.content);
      const sha256 = typeof activityResult.sha256 === 'string' &&
          /^[0-9a-f]{64}$/u.test(activityResult.sha256)
        ? activityResult.sha256
        : undefined;
      const outcome = activityResult.ok === true
        ? {
            type: 'success' as const,
            ...(purpose ? { purpose } : {}),
            ...(description ? { description } : {}),
            ...(content && new TextEncoder().encode(content).byteLength <= 32 * 1_024
              ? { content }
              : {}),
            ...(sha256 ? { sha256 } : {}),
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
    if (entry.type === 'knowledge') {
      const selectedKnowledgeBases = Array.isArray(activityResult.selectedKnowledgeBases)
        ? activityResult.selectedKnowledgeBases.flatMap((candidate) =>
            isRecord(candidate) &&
            typeof candidate.id === 'string' &&
            typeof candidate.name === 'string'
              ? [{ id: candidate.id, name: candidate.name }]
              : [],
          )
        : [];
      const hits = Array.isArray(activityResult.hits)
        ? activityResult.hits.filter(isRecord)
        : [];
      const citations: ConversationKnowledgeCitation[] = hits.flatMap((hit) =>
        typeof hit.citation === 'string' &&
        typeof hit.knowledgeBaseId === 'string' &&
        typeof hit.knowledgeBaseName === 'string' &&
        typeof hit.documentId === 'string' &&
        typeof hit.fileName === 'string' &&
        typeof hit.relativePath === 'string' &&
        typeof hit.content === 'string'
          ? [{
              citation: hit.citation,
              knowledgeBaseId: hit.knowledgeBaseId,
              knowledgeBaseName: hit.knowledgeBaseName,
              documentId: hit.documentId,
              fileName: hit.fileName,
              relativePath: hit.relativePath,
              ...(typeof hit.heading === 'string' ? { heading: hit.heading } : {}),
              ...(Number.isSafeInteger(hit.pageNumber)
                ? { pageNumber: Number(hit.pageNumber) }
                : {}),
              ...(hit.contentKind === 'text' || hit.contentKind === 'code'
                ? { contentKind: hit.contentKind }
                : {}),
              ...(typeof hit.language === 'string' ? { language: hit.language } : {}),
              ...(Number.isSafeInteger(hit.startLine)
                ? { startLine: Number(hit.startLine) }
                : {}),
              ...(Number.isSafeInteger(hit.endLine)
                ? { endLine: Number(hit.endLine) }
                : {}),
              content: hit.content,
            }]
          : [],
      );
      const rawListedBases = Array.isArray(activityResult.knowledgeBases)
        ? activityResult.knowledgeBases.filter(isRecord)
        : [];
      const listedBases = rawListedBases.flatMap((candidate) =>
        isRecord(candidate) &&
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string'
          ? [{ id: candidate.id, name: candidate.name }]
          : [],
      );
      const knowledgeBases = selectedKnowledgeBases.length > 0
        ? selectedKnowledgeBases
        : listedBases;
      const mode: 'fullText' | 'hybrid' | 'documentList' | 'read' =
        entry.activity.operation === 'search'
        ? activityResult.mode === 'hybrid'
          ? 'hybrid'
          : 'fullText'
        : entry.activity.operation === 'listDocuments'
          ? 'documentList'
          : 'read';
      const documents = rawListedBases.reduce(
        (count, base) => count + (Array.isArray(base.documents)
          ? base.documents.length
          : 0),
        0,
      );
      const chunks = Array.isArray(activityResult.chunks)
        ? activityResult.chunks.length
        : 0;
      const matches = entry.activity.operation === 'search'
        ? hits.length
        : entry.activity.operation === 'listDocuments'
          ? documents
          : chunks;
      const outcome = activityResult.ok === false || activityResult.error !== undefined
        ? { type: 'error' as const, kind: errorKind(activityResult) }
        : {
            type: 'success' as const,
            mode,
            matches,
            knowledgeBases,
            ...(citations.length > 0 ? { citations } : {}),
          };
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
  for (const item of orderedItems) {
    if (
      item.kind === 'turn.textCompleted' &&
      item.payload.phase === 'commentary'
    ) {
      const id = nonEmptyString(item.payload.itemId) ?? item.id;
      const text = String(item.payload.text ?? '');
      if (
        isTrustedCommentaryId(item.turnId, id) &&
        !activities.some(
          (activity) =>
            activity.type === 'commentary' && activity.activity.id === id,
        )
      ) {
        activities.push({
          type: 'commentary',
          activity: {
            id,
            text,
            status: 'completed',
          },
        });
      }
      continue;
    }
    if (
      item.kind === 'turn.userInputRequested' &&
      typeof item.payload.inputRequestId === 'string'
    ) {
      const questions = userInputQuestions(item.payload.questions);
      if (questions) {
        appendUserInputActivity(
          activities,
          item.payload.inputRequestId,
          questions,
        );
      }
      continue;
    }
    if (
      item.kind === 'turn.userInputResolved' &&
      typeof item.payload.inputRequestId === 'string'
    ) {
      const entry = activities.find(
        (activity) =>
          activity.type === 'userInput' &&
          activity.activity.id === item.payload.inputRequestId,
      );
      if (entry?.type === 'userInput') {
        const submission = userInputSubmission(
          item.payload,
          entry.activity.questions,
        );
        if (submission) {
          resolveUserInputActivity(
            activities,
            item.payload.inputRequestId,
            submission,
          );
        }
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
