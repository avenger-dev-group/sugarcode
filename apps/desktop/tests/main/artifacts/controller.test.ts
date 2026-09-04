import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const { default: { Workbook } } = await import('exceljs');
import JSZip from 'jszip';
import { ArtifactsController } from '../../../src/main/artifacts/controller.ts';
import { editWorkbook, readWorkbook } from '../../../src/main/artifacts/office.ts';

const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sugarcode-edit-')));
  const controller = new ArtifactsController({ getWorkspace: () => ({ path: root, workspaceId: 'fixture', generation: 4, name: 'Fixture', threadId: null }), getMainWindow: () => null, dialog: { showSaveDialog: async () => ({ canceled: true, filePath: '' }) }, openPath: async () => undefined, reveal: () => undefined });
  return { root, controller, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test('text editing keeps BOM, archives original bytes and rejects stale writes', async () => {
  const f = await fixture();
  try {
    const original = Buffer.from('\uFEFF原始文本\r\n');
    await writeFile(path.join(f.root, 'notes.md'), original);
    const doc = await f.controller.read(4, 'notes.md');
    assert.equal(doc.content, '原始文本\r\n');
    const saved = await f.controller.save(4, 'notes.md', doc.revision, { kind: 'text', content: '修改后\r\n' });
    assert.equal(saved.content, '修改后\r\n');
    assert.equal((await readFile(path.join(f.root, 'notes.md'))).toString(), '\uFEFF修改后\r\n');
    const versions = path.join(f.root, '.sugarcode', 'versions');
    const directory = path.join(versions, (await readdir(versions))[0]);
    assert.deepEqual(await readFile(path.join(directory, (await readdir(directory))[0])), original);
    await assert.rejects(f.controller.save(4, 'notes.md', doc.revision, { kind: 'text', content: 'stale' }), { code: 'CONFLICT' });
    await assert.rejects(f.controller.read(3, 'notes.md'), /当前工作目录/);
    await assert.rejects(f.controller.read(4, '../notes.md'), /当前工作目录/);
  } finally { await f.cleanup(); }
});

test('Word edits preserve formatting and unrelated package parts', async () => {
  const f = await fixture();
  try {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello</w:t></w:r><w:r><w:t> world</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
    zip.file('word/media/picture.png', Buffer.from([1, 2, 3]));
    zip.file('word/styles.xml', '<styles>untouched</styles>');
    await writeFile(path.join(f.root, 'report.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
    const doc = await f.controller.read(4, 'report.docx');
    assert.deepEqual(doc.paragraphs, ['Hello world', 'Table cell']);
    const saved = await f.controller.save(4, 'report.docx', doc.revision, { kind: 'docx', paragraphs: [{ index: 0, text: '更新 & <内容>' }] });
    assert.deepEqual(saved.paragraphs, ['更新 & <内容>', 'Table cell']);
    const result = await JSZip.loadAsync(await readFile(path.join(f.root, 'report.docx')));
    assert.equal(await result.file('word/styles.xml')?.async('string'), '<styles>untouched</styles>');
    assert.deepEqual(await result.file('word/media/picture.png')?.async('nodebuffer'), Buffer.from([1, 2, 3]));
    assert.match(await result.file('word/document.xml')?.async('string') ?? '', /<w:b\/>/);
  } finally { await f.cleanup(); }
});

test('spreadsheet cell and formula edits preserve styles, sheets and charts; invalidate cached calculations', async () => {
  const workbook = new Workbook();
  const first = workbook.addWorksheet('销售');
  first.getCell('A1').value = '收入';
  first.getCell('A1').font = { bold: true };
  first.getCell('B1').value = 20;
  first.getCell('C1').value = { formula: 'B1*2', result: 40 };
  first.mergeCells('A3:B3'); first.getCell('A3').value = '合并';
  workbook.addWorksheet('备注').getCell('A1').value = '保留';
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  zip.file('xl/charts/chart1.xml', '<chart>preserved</chart>');
  const input = await zip.generateAsync({ type: 'nodebuffer' });
  const displayed = await readWorkbook(input);
  assert.equal(displayed[0].rows[2][1].readOnly, true);
  const output = await editWorkbook(input, { kind: 'xlsx', cells: [{ sheetId: first.id, address: 'A1', text: '销售额' }, { sheetId: first.id, address: 'B1', text: '50' }, { sheetId: first.id, address: 'D4', text: '=SUM(B1:C1)' }] });
  const updated = new Workbook();
  await updated.xlsx.load(output as never);
  assert.equal(updated.worksheets[0].getCell('A1').text, '销售额');
  assert.equal(updated.worksheets[0].getCell('A1').font.bold, true);
  assert.equal(updated.worksheets[0].getCell('B1').value, 50);
  assert.equal(updated.worksheets[0].getCell('C1').formula, 'B1*2');
  assert.equal(updated.worksheets[0].getCell('C1').result, undefined);
  assert.equal(updated.worksheets[0].getCell('D4').formula, 'SUM(B1:C1)');
  assert.equal(updated.worksheets[1].getCell('A1').value, '保留');
  const result = await JSZip.loadAsync(output);
  assert.equal(await result.file('xl/charts/chart1.xml')?.async('string'), '<chart>preserved</chart>');
});

test('spreadsheet preview tolerates an embedded duplicate XML declaration', async () => {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('销售');
  sheet.getCell('A1').value = '商品';
  sheet.getCell('B1').value = 12;
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const source = await zip.file('xl/worksheets/sheet1.xml')?.async('string') ?? '';
  zip.file('xl/worksheets/sheet1.xml', source.replace(/<worksheet\b[^>]*>/u, (root) => `${root}<?xml version="1.0" encoding="UTF-8"?>`));
  const malformed = await zip.generateAsync({ type: 'nodebuffer' });
  const displayed = await readWorkbook(malformed);
  assert.equal(displayed[0].rows[0][0].text, '商品');
  assert.equal(displayed[0].rows[0][1].text, '12');
});

test('PDF notes persist separately with conflict detection and never modify PDF bytes', async () => {
  const f = await fixture();
  try {
    const pdf = Buffer.from('%PDF-1.7\nfixture');
    await writeFile(path.join(f.root, 'report.pdf'), pdf);
    const doc = await f.controller.read(4, 'report.pdf');
    const saved = await f.controller.save(4, 'report.pdf', doc.revision, { kind: 'pdf', notes: '确认数据口径', notesRevision: doc.notesRevision ?? '' });
    assert.equal(saved.notes, '确认数据口径');
    assert.deepEqual(await readFile(path.join(f.root, 'report.pdf')), pdf);
    await assert.rejects(f.controller.save(4, 'report.pdf', doc.revision, { kind: 'pdf', notes: 'stale', notesRevision: doc.notesRevision ?? '' }), { code: 'CONFLICT' });
    await assert.rejects(f.controller.save(4, 'report.pdf', doc.revision, { kind: 'text', content: 'oops' }), /类型不匹配/);
  } finally { await f.cleanup(); }
});

test('file and metadata symlinks cannot escape the workspace', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await writeFile(path.join(other.root, 'private.txt'), 'private');
    await symlink(path.join(other.root, 'private.txt'), path.join(f.root, 'link.txt'));
    await assert.rejects(f.controller.read(4, 'link.txt'), /当前工作目录/);
    await writeFile(path.join(f.root, 'notes.txt'), 'original');
    const doc = await f.controller.read(4, 'notes.txt');
    await symlink(other.root, path.join(f.root, '.sugarcode'));
    await assert.rejects(f.controller.save(4, 'notes.txt', doc.revision, { kind: 'text', content: 'changed' }), /符号链接/);
    assert.equal(await readFile(path.join(f.root, 'notes.txt'), 'utf8'), 'original');
    assert.deepEqual((await readdir(other.root)).sort(), ['private.txt']);
  } finally { await f.cleanup(); await other.cleanup(); }
});
