import { useEffect, useState } from 'react';

import type {
  ConversationFileChangeActivity,
  ConversationPhase,
  ConversationTurnStatus,
} from '@/shared/conversation';

import type {
  FileChangeReviewPresentationState,
  FileChangeReviewStore,
  FileChangeReviewViewModel,
} from './types';
import { parseUnifiedDiff } from './unified-diff';

const toPresentationState = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationFileChangeActivity,
): FileChangeReviewPresentationState => {
  if (activity.result?.status === 'completed') {
    return activity.result.outcome.type === 'success' ? 'applied' : 'failed';
  }
  if (turnStatus === 'interrupted') {
    return activity.change ? 'outcomeUnknown' : 'interrupted';
  }
  if (phase === 'stopping') {
    return 'stopping';
  }
  if (phase === 'unavailable') {
    return 'uncertain';
  }
  return activity.change ? 'applying' : 'preparing';
};

export const toFileChangeReviewViewModel = (
  phase: ConversationPhase,
  turnStatus: ConversationTurnStatus,
  activity: ConversationFileChangeActivity,
): FileChangeReviewViewModel => {
  const changes = activity.changes ?? (activity.change ? [activity.change] : []);
  const files = changes.map((change) => {
    const hunks = parseUnifiedDiff(change.diff);
    const lines = hunks.flatMap((hunk) => hunk.lines);
    return {
      id: change.id,
      path: change.path,
      kind: change.kind,
      hunks,
      additions: lines.filter((line) => line.kind === 'addition').length,
      deletions: lines.filter((line) => line.kind === 'deletion').length,
      beforeSha256: change.beforeSha256,
      afterSha256: change.afterSha256,
      beforeBytes: change.beforeBytes,
      afterBytes: change.afterBytes,
      newlineStyle: change.newlineStyle,
      finalNewline: change.finalNewline,
    } as const;
  });
  return {
    id: activity.id,
    path: files.length > 1 ? `${files.length} files` : activity.path,
    state: toPresentationState(phase, turnStatus, activity),
    ...(activity.result?.outcome.type === 'error'
      ? { errorKind: activity.result.outcome.kind }
      : {}),
    ...(files.length > 0
      ? {
          change: files[0],
          files,
        }
      : {}),
  };
};

export const useStore = (
  reviewId: string,
  initiallyExpanded = true,
): FileChangeReviewStore => {
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);

  useEffect(() => {
    setExpanded(initiallyExpanded);
  }, [initiallyExpanded, reviewId]);

  return {
    expanded,
    toggleExpanded: () => setExpanded((current) => !current),
  };
};
