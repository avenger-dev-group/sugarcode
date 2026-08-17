import type { ConversationWorkspacePatchFile } from '../../../shared/conversation.ts';
import { toWorkspacePatchReviewFile } from '../workspace/unified-diff.ts';

import type { TurnChangeSummaryProps } from './types';

export type TurnChangeSummaryFile = Readonly<{
  id: string;
  file: ConversationWorkspacePatchFile;
  reviews: readonly NonNullable<ReturnType<typeof toWorkspacePatchReviewFile>>[];
}>;

export const collectTurnChangeSummaryFiles = (
  activities: TurnChangeSummaryProps['activities'] | undefined,
): readonly TurnChangeSummaryFile[] => {
  const latestByPath = new Map<string, TurnChangeSummaryFile>();
  for (const entry of activities ?? []) {
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
