export type UnifiedDiffLine = Readonly<{
  kind: 'context' | 'addition' | 'deletion';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}>;

export type UnifiedDiffHunk = Readonly<{
  header: string;
  lines: readonly UnifiedDiffLine[];
}>;

export type FileChangeReviewPresentationState =
  | 'preparing'
  | 'applying'
  | 'stopping'
  | 'uncertain'
  | 'applied'
  | 'failed'
  | 'interrupted'
  | 'outcomeUnknown';

export type FileChangeReviewFile = Readonly<{
  id: string;
  path: string;
  kind: 'create' | 'update' | 'delete';
  hunks: readonly UnifiedDiffHunk[];
  additions: number;
  deletions: number;
  beforeSha256: string;
  afterSha256: string;
  beforeBytes: number;
  afterBytes: number;
  newlineStyle: 'lf' | 'crLf';
  finalNewline: boolean;
}>;

export type FileChangeReviewViewModel = Readonly<{
  id: string;
  path: string;
  state: FileChangeReviewPresentationState;
  errorKind?: string;
  change?: FileChangeReviewFile;
  files?: readonly FileChangeReviewFile[];
}>;

export type FileChangeReviewProps = Readonly<{
  review: FileChangeReviewViewModel;
  variant?: 'card' | 'compact';
  language?: 'en' | 'zh';
}>;

export type FileChangeReviewStore = Readonly<{
  expanded: boolean;
  toggleExpanded: () => void;
}>;
