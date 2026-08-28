import type { ConversationWorkspacePatchFile } from '../../../shared/conversation.ts';
import type { FileChangeReviewFile } from '../workspace/types.ts';
import { toWorkspacePatchReviewFile } from '../workspace/unified-diff.ts';

import type { TurnChangeSummaryProps } from './types';

export type TurnChangeSummaryFile = Readonly<{
  id: string;
  file: Pick<ConversationWorkspacePatchFile, 'path' | 'afterBytes'>;
  reviews: readonly FileChangeReviewFile[];
}>;

export const collectTurnChangeSummaryFiles = (
  activities: TurnChangeSummaryProps['activities'] | undefined,
): readonly TurnChangeSummaryFile[] => {
  const latestByPath = new Map<string, TurnChangeSummaryFile>();
  for (const entry of activities ?? []) {
    if (entry.type === 'fileChange' && entry.activity.state === 'applied') {
      const reviews = entry.activity.files ?? (
        entry.activity.change ? [entry.activity.change] : []
      );
      reviews.forEach((review) => {
        const previous = latestByPath.get(review.path);
        latestByPath.set(review.path, {
          id: previous?.id ?? `${entry.activity.id}:${review.id}`,
          file: review,
          reviews: [...(previous?.reviews ?? []), review],
        });
      });
      continue;
    }
    if (
      entry.type !== 'commandApproval' ||
      entry.activity.executionResult?.outcome.type !== 'workspacePatch'
    ) {
      continue;
    }
    entry.activity.executionResult.outcome.files?.forEach((file, index) => {
      const id = `${entry.activity.id}:${index}:${file.path}`;
      const review = toWorkspacePatchReviewFile(id, file);
      const previous = latestByPath.get(file.path);
      latestByPath.set(file.path, {
        id: previous?.id ?? id,
        file,
        reviews: [
          ...(previous?.reviews ?? []),
          ...(review ? [review] : []),
        ],
      });
    });
  }
  return [...latestByPath.values()];
};
