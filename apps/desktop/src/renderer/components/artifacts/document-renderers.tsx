import { useEffect, useRef, useState } from 'react';
import { Button } from '@/renderer/components/ui/button';
import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus } from 'lucide-react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const fromBase64 = (data: string): Uint8Array => Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));

export const WordPreview = ({ data }: { data: string }) => {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setHtml(''); setError('');
    void import('docx-preview').then(async ({ renderAsync }) => {
      const container = document.createElement('div');
      await renderAsync(fromBase64(data), container, undefined, { useBase64URL: true, ignoreFonts: true, renderAltChunks: false });
      if (active) setHtml(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;"><style>body{margin:0;background:#f4f4f3}.docx-wrapper{padding:20px!important}.docx-wrapper>section.docx{max-width:100%;box-sizing:border-box}</style></head><body>${container.innerHTML}</body></html>`);
    }).catch(() => { if (active) setError('Word 预览失败，可使用系统应用打开。'); });
    return () => { active = false; };
  }, [data]);
  return error ? <p role="alert" className="p-6 text-sm text-destructive">{error}</p> : html
    ? <iframe title="Word 文档预览" className="h-full min-h-0 w-full border-0" sandbox="" srcDoc={html} />
    : <Loading />;
};

export const PdfPreview = ({ data }: { data: string }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<import('pdfjs-dist').PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let destroy: (() => void) | undefined;
    setPdf(undefined); setPage(1); setError('');
    void import('pdfjs-dist').then(async (module) => {
      module.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const task = module.getDocument({ data: fromBase64(data), isEvalSupported: false });
      destroy = () => { void task.destroy(); };
      const document = await task.promise;
      if (active) setPdf(document); else destroy();
    }).catch(() => { if (active) setError('PDF 无法预览，文件可能已加密或损坏。'); });
    return () => { active = false; destroy?.(); };
  }, [data]);
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let renderTask: import('pdfjs-dist').RenderTask | undefined;
    void pdf.getPage(page).then(async (pdfPage) => {
      if (!active || !canvas.current) return;
      const viewport = pdfPage.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const element = canvas.current;
      element.width = Math.floor(viewport.width * ratio);
      element.height = Math.floor(viewport.height * ratio);
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      renderTask = pdfPage.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
    }).catch((error) => { if (active && error?.name !== 'RenderingCancelledException') setError('页面渲染失败。'); });
    return () => { active = false; renderTask?.cancel(); };
  }, [pdf, page, scale]);
  if (error) return <p role="alert" className="p-6 text-sm text-destructive">{error}</p>;
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-10 shrink-0 items-center justify-center gap-2 border-b text-xs">
      <Button variant="ghost" size="icon-xs" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
      <span>{page} / {pdf?.numPages ?? '—'}</span>
      <Button variant="ghost" size="icon-xs" aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
      <Button variant="ghost" size="icon-xs" aria-label="缩小 PDF" disabled={scale <= 0.5} onClick={() => setScale(Math.max(0.5, scale - 0.25))}><Minus /></Button>
      <span>{Math.round(scale * 100)}%</span>
      <Button variant="ghost" size="icon-xs" aria-label="放大 PDF" disabled={scale >= 2} onClick={() => setScale(Math.min(2, scale + 0.25))}><Plus /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto bg-surface p-4"><canvas ref={canvas} className="mx-auto bg-white shadow-sm" aria-label={`PDF 第 ${page} 页`} />{!pdf ? <Loading /> : null}</div>
  </div>;
};
const Loading = () => <div className="grid h-full place-items-center p-6 text-sm text-secondary"><span className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />正在渲染…</span></div>;
