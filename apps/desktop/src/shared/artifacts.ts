export const ARTIFACTS_CHANNEL = 'artifacts:request';
export type ArtifactKind = 'text' | 'docx' | 'xlsx' | 'pdf' | 'image' | 'unsupported';
export type ArtifactCell = Readonly<{ address: string; text: string; formula?: string; readOnly?: boolean; bold?: boolean; color?: string; background?: string }>;
export type ArtifactSheet = Readonly<{ id: number; name: string; rows: readonly (readonly ArtifactCell[])[]; rowCount: number; columnCount: number; truncated: boolean }>;
export type ArtifactDocument = Readonly<{
  path: string; identity: string; revision: string; kind: ArtifactKind; bytes: number;
  content?: string; data?: string; mediaType?: string;
  paragraphs?: readonly string[]; sheets?: readonly ArtifactSheet[];
  notes?: string; notesRevision?: string;
}>;
export type ArtifactEdits =
  | { kind: 'text'; content: string }
  | { kind: 'docx'; paragraphs: readonly { index: number; text: string }[] }
  | { kind: 'xlsx'; cells: readonly { sheetId: number; address: string; text: string }[] }
  | { kind: 'pdf'; notes: string; notesRevision: string };
export type ArtifactRequest = Readonly<{ generation: number; path: string }> & (
  | { action: 'read' | 'openExternal' | 'reveal' | 'export' }
  | { action: 'save'; expectedRevision: string; edits: ArtifactEdits }
);
export type ArtifactResult = Readonly<{ accepted: boolean; document?: ArtifactDocument; error?: string; conflict?: boolean }>;
export type ArtifactsApi = Readonly<{ requestArtifact: (request: ArtifactRequest) => Promise<ArtifactResult> }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0');
export const isArtifactRequest = (v: unknown): v is ArtifactRequest => {
  if (!record(v) || !Number.isSafeInteger(v.generation) || !text(v.path, 4096) || !v.path) return false;
  if (['read', 'openExternal', 'reveal', 'export'].includes(String(v.action))) return true;
  if (v.action !== 'save' || !text(v.expectedRevision, 64) || !record(v.edits)) return false;
  const e = v.edits;
  if (e.kind === 'text') return text(e.content, 2_000_000);
  if (e.kind === 'pdf') return text(e.notes, 100_000) && text(e.notesRevision, 64);
  if (e.kind === 'docx') return Array.isArray(e.paragraphs) && e.paragraphs.length <= 10_000 && e.paragraphs.every((p) => record(p) && Number.isSafeInteger(p.index) && Number(p.index) >= 0 && text(p.text, 100_000));
  return e.kind === 'xlsx' && Array.isArray(e.cells) && e.cells.length <= 10_000 && e.cells.every((c) => record(c) && Number.isSafeInteger(c.sheetId) && Number(c.sheetId) > 0 && typeof c.address === 'string' && /^[A-Z]{1,3}[1-9]\d{0,6}$/u.test(c.address) && text(c.text, 32_767));
};
export const artifactKind = (filePath: string): ArtifactKind => {
  const ext = filePath.split('.').at(-1)?.toLocaleLowerCase();
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pdf') return ext;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext ?? '')) return 'image';
  if (['doc', 'xls', 'ppt', 'pptx', 'zip', '7z', 'exe', 'dmg', 'mp4', 'mov', 'webm', 'mp3', 'wav'].includes(ext ?? '')) return 'unsupported';
  return 'text';
};
export const isArtifactDocument = (v: unknown): v is ArtifactDocument => record(v) &&
  text(v.path, 4096) && text(v.identity, 64) && text(v.revision, 64) &&
  ['text', 'docx', 'xlsx', 'pdf', 'image', 'unsupported'].includes(String(v.kind)) &&
  typeof v.bytes === 'number' && Number.isFinite(v.bytes) &&
  (v.content === undefined || text(v.content, 2_000_000)) &&
  (v.data === undefined || text(v.data, 40_000_000)) &&
  (v.paragraphs === undefined || (Array.isArray(v.paragraphs) && v.paragraphs.every((p) => text(p, 2_000_000)))) &&
  (v.sheets === undefined || (Array.isArray(v.sheets) && v.sheets.every((s) => record(s) && typeof s.id === 'number' && text(s.name, 1024) && Array.isArray(s.rows) && s.rows.every((r) => Array.isArray(r) && r.every((c) => record(c) && text(c.address, 16) && text(c.text, 100_000))))));
