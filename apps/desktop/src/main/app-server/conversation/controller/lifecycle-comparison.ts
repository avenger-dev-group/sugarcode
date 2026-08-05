import type {
  ConversationCommandExecutionResultOutcome,
  ConversationFileChangeProposal,
  ConversationFileChangeResultOutcome,
  ConversationWorkspaceListOutcome,
  ConversationWorkspaceReadOutcome,
  ConversationWorkspaceSearchOutcome,
} from '@/shared/conversation';

import type {
  WorkspacePatchChangeItem,
  WorkspacePatchResultItem,
} from '../file-change-protocol';

export const toFileChangeProposal = (
  item: WorkspacePatchChangeItem,
): ConversationFileChangeProposal => ({
  id: item.id,
  status: item.status,
  path: item.path,
  kind: item.kind,
  diff: item.diff,
  beforeSha256: item.beforeSha256,
  afterSha256: item.afterSha256,
  beforeBytes: item.beforeBytes,
  afterBytes: item.afterBytes,
  newlineStyle: item.newlineStyle,
  finalNewline: item.finalNewline,
});

export const patchResultMatchesChange = (
  outcome: WorkspacePatchResultItem['outcome'],
  change: ConversationFileChangeProposal | undefined,
  changes: readonly ConversationFileChangeProposal[] = change ? [change] : [],
): boolean =>
  outcome.type === 'error' ||
  ('files' in outcome
    ? outcome.files.length === changes.length &&
      outcome.files.every((receipt, index) => {
        const proposed = changes[index];
        return Boolean(
          proposed?.status === 'completed' &&
            receipt.path === proposed.path &&
            receipt.kind === proposed.kind &&
            receipt.beforeSha256 === proposed.beforeSha256 &&
            receipt.afterSha256 === proposed.afterSha256 &&
            receipt.beforeBytes === proposed.beforeBytes &&
            receipt.afterBytes === proposed.afterBytes,
        );
      })
    : Boolean(
        change?.status === 'completed' &&
          outcome.path === change.path &&
          outcome.beforeSha256 === change.beforeSha256 &&
          outcome.afterSha256 === change.afterSha256 &&
          outcome.beforeBytes === change.beforeBytes &&
          outcome.afterBytes === change.afterBytes,
      ));

export const fileChangeProposalsEqual = (
  left: ConversationFileChangeProposal,
  right: ConversationFileChangeProposal,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const fileChangeResultsEqual = (
  left: ConversationFileChangeResultOutcome,
  right: WorkspacePatchResultItem['outcome'],
): boolean => JSON.stringify(left) === JSON.stringify(right);

export const outcomesEqual = (
  left: ConversationWorkspaceReadOutcome,
  right: ConversationWorkspaceReadOutcome,
): boolean =>
  left.type === right.type &&
  (left.type === 'success' && right.type === 'success'
    ? left.bytes === right.bytes
    : left.type === 'error' &&
      right.type === 'error' &&
      left.kind === right.kind);

export const listOutcomesEqual = (
  left: ConversationWorkspaceListOutcome,
  right: ConversationWorkspaceListOutcome,
): boolean =>
  left.type === right.type &&
  (left.type === 'success' && right.type === 'success'
    ? left.entries === right.entries
    : left.type === 'error' &&
      right.type === 'error' &&
      left.kind === right.kind);

export const searchOutcomesEqual = (
  left: ConversationWorkspaceSearchOutcome,
  right: ConversationWorkspaceSearchOutcome,
): boolean =>
  left.type === right.type &&
  (left.type === 'success' && right.type === 'success'
    ? left.matches === right.matches && left.truncated === right.truncated
    : left.type === 'error' &&
      right.type === 'error' &&
      left.kind === right.kind);

export const commandExecutionOutcomesEqual = (
  left: ConversationCommandExecutionResultOutcome,
  right: ConversationCommandExecutionResultOutcome,
): boolean => JSON.stringify(left) === JSON.stringify(right);
