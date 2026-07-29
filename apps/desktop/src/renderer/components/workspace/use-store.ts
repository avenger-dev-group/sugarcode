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
  const change = activity.change;
  const hunks = change ? parseUnifiedDiff(change.diff) : undefined;
  const lines = hunks?.flatMap((hunk) => hunk.lines) ?? [];
  return {
    id: activity.id,
    path: activity.path,
    state: toPresentationState(phase, turnStatus, activity),
    ...(activity.result?.outcome.type === 'error'
      ? { errorKind: activity.result.outcome.kind }
      : {}),
    ...(change && hunks
      ? {
          change: {
            id: change.id,
            hunks,
            additions: lines.filter((line) => line.kind === 'addition').length,
            deletions: lines.filter((line) => line.kind === 'deletion').length,
            beforeSha256: change.beforeSha256,
            afterSha256: change.afterSha256,
            beforeBytes: change.beforeBytes,
            afterBytes: change.afterBytes,
            newlineStyle: change.newlineStyle,
            finalNewline: change.finalNewline,
          },
        }
      : {}),
  };
};

export const useStore = (reviewId: string): FileChangeReviewStore => {
  const [expanded, setExpanded] = useState<boolean>(true);

  useEffect(() => {
    setExpanded(true);
  }, [reviewId]);

  return {
    expanded,
    toggleExpanded: () => setExpanded((current) => !current),
  };
};
