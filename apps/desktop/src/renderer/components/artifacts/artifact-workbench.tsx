import { Download, ExternalLink, FileText, FolderOpen, LoaderCircle, Pencil, RefreshCw, Save, Undo2 } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/renderer/components/ui/button';
import { FileInspector } from '@/renderer/components/workspace/workbench/file-inspector';
import { resolveWorkspaceFile } from '@/renderer/services/workspace';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import { isAbsoluteWorkspaceFileReference } from '@/shared/workspace-file-reference';
import { isArtifactRequest, type ArtifactDocument, type ArtifactEdits } from '@/shared/artifacts';
import { SpreadsheetEditor } from './spreadsheet-editor';

const WordPreview = lazy(() => import('./document-renderers').then((m) => ({ default: m.WordPreview })));
const PdfPreview = lazy(() => import('./document-renderers').then((m) => ({ default: m.PdfPreview })));
type Draft = { revision: string; edits: ArtifactEdits };
const drafts = new Map<string, Draft>();
const draftKey = (identity: string): string => `sugarcode.artifact.draft.${identity}`;
const loadDraft = (document: ArtifactDocument): Draft | undefined => {
  if (drafts.has(document.identity)) return drafts.get(document.identity);
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(document.identity)) ?? 'null') as Draft | null;
    if (draft && isArtifactRequest({ action: 'save', generation: 0, path: document.path, expectedRevision: draft.revision, edits: draft.edits })) return draft;
  } catch { /* A damaged draft never replaces the actual file. */ }
  return undefined;
};

export const ArtifactWorkbench = ({ path }: { path: string }) => {
  const workspace = useStore(workspaceProjectionStore, (s) => s.snapshot);
  const [document, setDocument] = useState<ArtifactDocument>();
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const resolvedPath = useRef(path);
  const dirty = useRef(false);
  dirty.current = !!draft;
  const reload = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    setLoading(true); setError('');
    try {
      if (workspace.status !== 'ready') throw new Error('请先打开此文件所属的项目。');
      let relative = path;
      if (isAbsoluteWorkspaceFileReference(path) || !path.includes('/')) {
        const resolved = await resolveWorkspaceFile({ generation: workspace.generation, reference: path });
        if (!resolved.accepted || resolved.status !== 'resolved' || !resolved.path) throw new Error('无法定位此文件，请检查文件路径。');
        relative = resolved.path;
      }
      if (token !== generation.current) return;
      resolvedPath.current = relative;
      const result = await window.sugarcode.requestArtifact({ action: 'read', generation: workspace.generation, path: relative });
      if (token !== generation.current) return;
      if (!result.accepted || !result.document) throw new Error(result.error ?? '文件读取失败。');
      const restored = loadDraft(result.document);
      setDocument(result.document); setDraft(restored);
      if (restored) {
        setEditing(true);
        if (restored.revision !== result.document.revision) setError('已恢复未保存的修改，但文件已有新版本。请核对后重新编辑。');
      }
    } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : '文件读取失败。'); }
    finally { if (token === generation.current) setLoading(false); }
  }, [path, workspace.generation, workspace.status]);
  useEffect(() => { resolvedPath.current = path; setDocument(undefined); setDraft(undefined); setEditing(false); setMessage(''); void reload(); return () => { generation.current += 1; }; }, [reload, path]);
  useEffect(() => {
    const finished = new Set<string>();
    return window.sugarcode.onConversationThreadProjectionChanged((snapshot) => {
      const last = snapshot.turns.at(-1);
      if (last && last.status !== 'inProgress' && !finished.has(last.id)) {
        finished.add(last.id);
        if (!dirty.current && snapshot.workspaceId && workspace.status === 'ready') void reload();
      }
    });
  }, [reload, workspace.status]);
  const setEdits = (edits: ArtifactEdits): void => {
    if (!document || saving) return;
    const next = { revision: draft?.revision ?? document.revision, edits };
    setDraft(next); drafts.set(document.identity, next); setMessage('');
    try { localStorage.setItem(draftKey(document.identity), JSON.stringify(next)); }
    catch { setMessage('修改暂存于当前应用，请及时保存。'); }
  };
  const clearDraft = (): void => {
    if (document) {
      drafts.delete(document.identity);
      try { localStorage.removeItem(draftKey(document.identity)); } catch { /* Memory draft still clears. */ }
    }
    setDraft(undefined);
  };
  const save = async (): Promise<void> => {
    if (!document || !draft || saving) return;
    const token = generation.current;
    setSaving(true); setError('');
    try {
      const result = await window.sugarcode.requestArtifact({ action: 'save', generation: workspace.generation, path: document.path, expectedRevision: draft.revision, edits: draft.edits });
      if (!result.accepted || !result.document) throw new Error(result.error ?? '保存失败。');
      if (token !== generation.current) return;
      clearDraft(); setDocument(result.document); setMessage(document.kind === 'pdf' ? '批注已保存到工作目录' : '已保存，修改前版本已保留');
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败。'); }
    finally { setSaving(false); }
  };
  const fileAction = (action: 'openExternal' | 'reveal' | 'export'): void => {
    void window.sugarcode.requestArtifact({ action, generation: workspace.generation, path: document?.path ?? resolvedPath.current }).then((result) => { if (!result.accepted) setError(result.error ?? '操作失败。'); }).catch(() => setError('文件操作失败。'));
  };
  const editable = document && ['text', 'docx', 'xlsx', 'pdf'].includes(document.kind);
  return <section className="flex h-full min-h-0 flex-col" aria-label={`产物：${path}`}>
    <header className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5">
      <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-secondary"><FileText className="size-3.5 shrink-0" /><span className="max-w-44 truncate" title={path}>{path.split('/').at(-1)}</span>{draft ? <span className="text-amber-600">· 未保存</span> : null}</span>
      {editable && document.kind !== 'xlsx' ? <Button variant={editing ? 'secondary' : 'ghost'} size="icon-xs" aria-label={document.kind === 'pdf' ? '编辑批注' : editing ? '查看预览' : '编辑内容'} title={document.kind === 'pdf' ? '编辑批注' : '编辑 / 预览'} onClick={() => setEditing(!editing)}><Pencil /></Button> : null}
      {draft ? <><Button variant="ghost" size="icon-xs" disabled={saving} aria-label="放弃未保存的修改" title="放弃修改" onClick={() => { clearDraft(); setError(''); setMessage('已放弃未保存的修改'); }}><Undo2 /></Button><Button size="sm" className="h-7 text-xs" disabled={saving || draft.revision !== document?.revision} onClick={() => void save()}>{saving ? <LoaderCircle className="size-3 animate-spin" /> : <Save className="size-3" />}保存</Button></> : null}
      <Button variant="ghost" size="icon-xs" disabled={loading || saving || !!draft} aria-label="重新读取文件" title="重新读取" onClick={() => void reload()}><RefreshCw /></Button>
      <Button variant="ghost" size="icon-xs" disabled={!!draft} aria-label="导出文件" title="导出" onClick={() => fileAction('export')}><Download /></Button>
      <Button variant="ghost" size="icon-xs" aria-label="使用系统应用打开" title="使用系统应用打开" onClick={() => fileAction('openExternal')}><ExternalLink /></Button>
      <Button variant="ghost" size="icon-xs" aria-label="打开文件所在目录" title="打开所在目录" onClick={() => fileAction('reveal')}><FolderOpen /></Button>
    </header>
    {error ? <p role="alert" className="shrink-0 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}
    {message ? <p role="status" className="shrink-0 border-b px-3 py-1.5 text-[11px] text-secondary">{message}</p> : null}
    {loading ? <div className="grid flex-1 place-items-center text-secondary"><LoaderCircle className="size-5 animate-spin" /></div> : document ? <fieldset disabled={saving} className="min-h-0 min-w-0 flex-1 border-0 p-0">
      {document.kind === 'text' ? editing ? <textarea className="h-full w-full resize-none bg-background p-4 font-mono text-xs leading-6 outline-none" aria-label="编辑文本内容" value={draft?.edits.kind === 'text' ? draft.edits.content : document.content} onChange={(e) => setEdits({ kind: 'text', content: e.target.value })} /> : <div className="flex h-full min-h-0 flex-col"><FileInspector document={{ status: 'complete', path: document.path, content: draft?.edits.kind === 'text' ? draft.edits.content : document.content ?? '', bytes: document.bytes, lines: (document.content?.split('\n').length ?? 1), hasUtf8Bom: false }} /></div>
      : document.kind === 'xlsx' ? <SpreadsheetEditor document={document} changes={draft?.edits.kind === 'xlsx' ? draft.edits : undefined} onChange={setEdits} />
      : document.kind === 'docx' ? editing ? <div className="h-full overflow-auto p-4"><p className="mb-4 text-xs leading-5 text-secondary">编辑段落文字，保留原文件中的样式、表格与图片。保存后查看最新预览。</p>{document.paragraphs?.map((paragraph, index) => <label key={index} className="mb-3 block"><span className="mb-1 block text-[10px] text-tertiary">段落 {index + 1}</span><textarea className="min-h-16 w-full resize-y rounded-lg border bg-background p-3 text-sm leading-6 outline-none focus:ring-2 focus:ring-ring" value={(draft?.edits.kind === 'docx' ? draft.edits.paragraphs.find((p) => p.index === index)?.text : undefined) ?? paragraph} onChange={(e) => setEdits({ kind: 'docx', paragraphs: [...(draft?.edits.kind === 'docx' ? draft.edits.paragraphs : []).filter((p) => p.index !== index), { index, text: e.target.value }] })} /></label>)}</div> : <Suspense fallback={<div className="p-6 text-sm">正在加载 Word 预览…</div>}><WordPreview data={document.data ?? ''} /></Suspense>
      : document.kind === 'pdf' ? <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1"><Suspense fallback={<div className="p-6 text-sm">正在加载 PDF…</div>}><PdfPreview data={document.data ?? ''} /></Suspense></div>{editing ? <label className="flex h-40 shrink-0 flex-col gap-2 border-t p-3 text-xs text-secondary">审阅批注 · 保存到工作目录<textarea className="min-h-0 flex-1 resize-none rounded-md border bg-background p-2 text-sm text-foreground outline-none" value={draft?.edits.kind === 'pdf' ? draft.edits.notes : document.notes ?? ''} onChange={(e) => setEdits({ kind: 'pdf', notes: e.target.value, notesRevision: document.notesRevision ?? '' })} /></label> : null}</div>
      : document.kind === 'image' ? <div className="grid h-full place-items-center overflow-auto bg-surface p-4"><img className="max-h-full max-w-full object-contain" src={`data:${document.mediaType};base64,${document.data}`} alt={document.path.split('/').at(-1)} /></div>
      : <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-secondary"><FileText className="size-8 text-tertiary" /><p>此文件可使用系统应用查看和编辑。</p><Button variant="outline" onClick={() => fileAction('openExternal')}>打开文件</Button></div>}
    </fieldset> : null}
  </section>;
};
