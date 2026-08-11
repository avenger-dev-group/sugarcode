import type { WorkspaceEntry } from '@/shared/workspace';

const ENTRY_KIND_ORDER: Readonly<Record<WorkspaceEntry['kind'], number>> = {
  directory: 0,
  file: 1,
  link: 2,
  other: 3,
};

const FILE_NAME_COLLATOR = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
});

const EXACT_FILE_NAME_COLLATOR = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'variant',
});

export const orderWorkspaceEntries = (
  entries: readonly WorkspaceEntry[],
): readonly WorkspaceEntry[] =>
  [...entries].sort(
    (left, right) =>
      ENTRY_KIND_ORDER[left.kind] - ENTRY_KIND_ORDER[right.kind] ||
      FILE_NAME_COLLATOR.compare(left.name, right.name) ||
      EXACT_FILE_NAME_COLLATOR.compare(left.name, right.name) ||
      left.path.localeCompare(right.path, 'en-US'),
  );
