import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { Workbook } from 'exceljs';

export const prepareScheduleFixtures = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'notes.md'), '# Daily report\n\nInitial analysis.');
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Sales');
  sheet.addRows([['Region', 'Revenue'], ['East', 120], ['West', 90]]);
  sheet.getRow(1).font = { bold: true };
  await workbook.xlsx.writeFile(path.join(root, 'sales.xlsx'));
  const word = new JSZip();
  word.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  word.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  word.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Daily report</w:t></w:r></w:p><w:p><w:r><w:t>Review the latest sales figures.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:bottom="1000" w:left="1000" w:right="1000"/></w:sectPr></w:body></w:document>');
  await writeFile(path.join(root, 'report.docx'), await word.generateAsync({ type: 'nodebuffer' }));
  const content = 'BT /F1 20 Tf 40 220 Td (Daily report) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 280] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(path.join(root, 'report.pdf'), pdf);
};

/** Serialized into the private E2E renderer; all interactions use the real UI/IPC. */
export const schedulesRendererProbe = async (root: string): Promise<string[]> => {
  const checks: string[] = [];
  const wait = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error(`Schedules E2E timed out: ${label}. ${document.body.innerText.slice(-3000)}`);
  };
  const check = (ok: unknown, label: string): void => { if (!ok) throw new Error(`Schedules E2E failed: ${label}`); checks.push(label); };
  const button = (label: string, scope: ParentNode = document): HTMLButtonElement | undefined => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().includes(label));
  const set = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  (await wait(() => button('定时任务'), 'sidebar entry')).click();
  (await wait(() => button('新建定时任务'), 'create button')).click();
  const form = await wait(() => document.querySelector<HTMLFormElement>('[role="dialog"] form') ?? undefined, 'editor');
  const name = form.querySelector<HTMLInputElement>('input[placeholder="例如：每日销售分析"]');
  const prompt = form.querySelector<HTMLTextAreaElement>('textarea');
  const directory = form.querySelector<HTMLInputElement>('#schedule-directory');
  if (!name || !prompt || !directory) throw new Error('Schedule editor fields missing');
  set(name, 'E2E 每日经营分析'); set(prompt, '分析销售数据并保存报告。'); set(directory, root);
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  button('保存计划', form)?.click();
  await wait(() => form.isConnected ? undefined : true, 'save editor');
  let state = await window.sugarcode.requestSchedules({ action: 'get' });
  const task = state.snapshot?.tasks.find((t) => t.name === 'E2E 每日经营分析');
  check(task, 'schedule creation through UI persists');
  if (!task) throw new Error('Missing schedule');
  // Fail locally before any provider/network call, exercising actual background turn recovery.
  await window.sugarcode.requestSchedules({ action: 'save', id: task.id, input: { ...task, modelProfileId: 'e2e-missing-model', enabled: false } });
  const foreground = await window.sugarcode.getConversationState();
  (await wait(() => button('立即运行'), 'run now')).click();
  const run = await wait(async () => {
    state = await window.sugarcode.requestSchedules({ action: 'get' });
    return state.snapshot?.runs.find((r) => r.scheduleId === task.id && r.status === 'failed');
  }, 'failed run history');
  check(!!run.threadId && !!run.error, 'background failure preserves actionable run and thread');
  const after = await window.sugarcode.getConversationState();
  check(after.threadId === foreground.threadId && after.workspaceId === foreground.workspaceId, 'background run leaves foreground selection unchanged');
  (await wait(() => button('执行记录'), 'run history tab')).click();
  (await wait(() => button('打开结果'), 'open run')).click();
  const detail = await wait(() => document.querySelector<HTMLElement>(`[aria-label="定时任务执行详情：${task.name}"]`) ?? undefined, 'scheduled run detail');
  check(true, 'review result opens inside scheduled tasks');
  const scheduledWorkspace = await window.sugarcode.getWorkspaceState();
  check(
    scheduledWorkspace.name === `定时任务 · ${task.name}` &&
    !scheduledWorkspace.projects?.some((project) => project.name === root.split('/').at(-1)) &&
    !scheduledWorkspace.projectThreadIds?.includes(run.threadId ?? ''),
    'scheduled result stays out of normal project navigation',
  );
  const detailRailToggle = detail.querySelector<HTMLButtonElement>('button[aria-controls="workspace-tools"]');
  check(detailRailToggle, 'scheduled result exposes the right pane toggle');
  if (detailRailToggle?.getAttribute('aria-expanded') !== 'true') detailRailToggle?.click();
  const launcher = await wait(() => document.querySelector<HTMLElement>('[aria-label="右侧工作区"]')
    ?? document.querySelector<HTMLElement>('[aria-label="项目文件树"]') ?? undefined, 'right pane');
  if (launcher.getAttribute('aria-label') === '右侧工作区') button('文件', launcher)?.click();
  await wait(() => document.querySelector('[aria-label="项目文件树"]') ?? undefined, 'files pane');
  const openFile = async (file: string): Promise<HTMLElement> => {
    (await wait(() => document.querySelector<HTMLButtonElement>(`[aria-label="项目文件树"] button[title="${file}"]`) ?? undefined, `file ${file}`)).click();
    return wait(() => document.querySelector<HTMLElement>(`[aria-label="产物：${file}"]`) ?? undefined, `artifact ${file}`);
  };
  const save = async (pane: HTMLElement): Promise<void> => {
    (await wait(() => button('保存', pane), 'save file')).click();
    await wait(() => pane.querySelector('[role="status"]')?.textContent?.includes('已保存') ? true : undefined, 'saved file');
  };
  const text = await openFile('notes.md');
  (await wait(() => text.querySelector<HTMLButtonElement>('[aria-label="编辑内容"]') ?? undefined, 'text editor')).click();
  const textarea = await wait(() => text.querySelector<HTMLTextAreaElement>('textarea') ?? undefined, 'text input');
  set(textarea, '# Reviewed report\n\nConfirmed.'); await save(text);
  check(true, 'text edit and save in right pane');
  const word = await openFile('report.docx');
  await wait(() => word.querySelector('iframe[title="Word 文档预览"]') ?? undefined, 'Word preview');
  word.querySelector<HTMLButtonElement>('[aria-label="编辑内容"]')?.click();
  const paragraph = await wait(() => word.querySelector<HTMLTextAreaElement>('textarea') ?? undefined, 'Word paragraph editor');
  set(paragraph, 'Reviewed daily report'); await save(word);
  check(true, 'Word preview and paragraph save');
  const pdf = await openFile('report.pdf');
  await wait(() => { const canvas = pdf.querySelector('canvas'); return canvas && canvas.style.width && canvas.height > 150 ? canvas : undefined; }, 'PDF rendered page');
  pdf.querySelector<HTMLButtonElement>('[aria-label="编辑批注"]')?.click();
  const notes = await wait(() => pdf.querySelector<HTMLTextAreaElement>('textarea') ?? undefined, 'PDF notes');
  set(notes, '数据已核对。'); await save(pdf);
  check(true, 'PDF rendering and persistent review notes');
  const excel = await openFile('sales.xlsx');
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  check(excel.isConnected && document.querySelector('[aria-label="项目文件树"]') !== null, 'scheduled result keeps the right pane open after the first file click');
  const fileTabs = [...document.querySelectorAll<HTMLButtonElement>('#workspace-tools button[title]')].map((entry) => entry.title);
  check(fileTabs.includes('notes.md') && fileTabs.includes('sales.xlsx'), 'scheduled result preserves multiple artifact tabs');
  const cell = await wait(() => excel.querySelector<HTMLButtonElement>('[aria-label="Sales B2"]') ?? undefined, 'spreadsheet cell');
  cell.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
  await wait(() => excel.textContent?.includes('B2') ? true : undefined, 'spreadsheet selection');
  const formula = await wait(() => excel.querySelector<HTMLInputElement>('[aria-label="单元格内容或公式"]') ?? undefined, 'spreadsheet formula bar');
  set(formula, '150');
  formula.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await save(excel);
  const savedCell = await wait(() => excel.querySelector<HTMLButtonElement>('[aria-label="Sales B2"]')?.textContent?.trim() === '150' ? true : undefined, 'saved spreadsheet value');
  check(savedCell, 'Excel cell edit and save');
  const firstCell = excel.querySelector<HTMLButtonElement>('[aria-label="Sales A1"]');
  const rangeEnd = excel.querySelector<HTMLButtonElement>('[aria-label="Sales B2"]');
  firstCell?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
  rangeEnd?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
  await wait(() => excel.textContent?.includes('A1:B2') ? true : undefined, 'spreadsheet drag selection');
  check(excel.querySelectorAll('[role="gridcell"][aria-selected="true"]').length === 4, 'Excel drag selects a rectangular range');
  return checks;
};
