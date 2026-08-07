import type { WorkspaceInspectDocument } from '@/shared/workspace';

export type WorkspaceDocumentStore = Readonly<{
  document: WorkspaceInspectDocument | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}>;
