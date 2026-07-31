import type {
  CompactToolActivity,
  TurnActivityViewModel,
} from './types';

export const isCompactToolActivity = (
  entry: TurnActivityViewModel | undefined,
): entry is CompactToolActivity => {
  if (!entry) {
    return false;
  }
  if (
    entry.type === 'workspaceRead' ||
    entry.type === 'workspaceList' ||
    entry.type === 'workspaceSearch' ||
    entry.type === 'fileChange'
  ) {
    return true;
  }
  if (entry.type === 'commandApproval') {
    return (
      entry.activity.state !== 'awaiting' && entry.activity.state !== 'stopping'
    );
  }
  if (entry.type === 'mcp') {
    return entry.activity.state !== 'awaiting';
  }
  return false;
};
