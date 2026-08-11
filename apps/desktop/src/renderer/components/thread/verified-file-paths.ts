import type {
  ConversationCommandApprovalActivity,
  ConversationFileChangeActivity,
  ConversationTurn,
  ConversationWorkspaceReadActivity,
} from '@/shared/conversation';

const applyWorkspaceRead = (
  paths: Set<string>,
  activity: ConversationWorkspaceReadActivity | undefined,
): void => {
  if (
    activity?.result?.status === 'completed' &&
    activity.result.outcome.type === 'success'
  ) {
    paths.add(activity.path);
  }
};

const applyFileChange = (
  paths: Set<string>,
  activity: ConversationFileChangeActivity | undefined,
): void => {
  if (
    activity?.result?.status !== 'completed' ||
    activity.result.outcome.type !== 'success'
  ) {
    return;
  }
  const outcome = activity.result.outcome;
  if ('files' in outcome) {
    for (const file of outcome.files) {
      if (file.kind === 'delete') {
        paths.delete(file.path);
      } else {
        paths.add(file.path);
      }
    }
    return;
  }
  if (activity.change?.kind === 'delete') {
    paths.delete(outcome.path);
  } else {
    paths.add(outcome.path);
  }
};

const applyCommandResult = (
  paths: Set<string>,
  activity: ConversationCommandApprovalActivity | undefined,
): void => {
  const outcome = activity?.executionResult?.outcome;
  if (
    activity?.executionResult?.status !== 'completed' ||
    outcome?.type !== 'workspacePatch' ||
    !outcome.files
  ) {
    return;
  }
  for (const file of outcome.files) {
    if (file.kind === 'delete') {
      paths.delete(file.path);
    } else {
      paths.add(file.path);
    }
  }
};

export const collectTurnVerifiedFilePaths = (
  turn: ConversationTurn,
): readonly string[] => {
  const paths = new Set<string>();
  applyWorkspaceRead(paths, turn.workspaceRead);
  applyFileChange(paths, turn.fileChange);
  applyCommandResult(paths, turn.commandApproval);
  for (const entry of turn.activities ?? []) {
    switch (entry.type) {
      case 'workspaceRead':
        applyWorkspaceRead(paths, entry.activity);
        break;
      case 'fileChange':
        applyFileChange(paths, entry.activity);
        break;
      case 'commandApproval':
        applyCommandResult(paths, entry.activity);
        break;
      default:
        break;
    }
  }
  return [...paths];
};
