import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { ArtifactEdits, ArtifactSheet } from '../../shared/artifacts.ts';

const loadOffice = async (bytes: Uint8Array): Promise<JSZip> => {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    total += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (total > 100 * 1024 * 1024) throw new Error('文档展开后超过 100 MB，请使用系统应用打开。');
  }
  return zip;
};

const escapeXml = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const unescapeXml = (value: string): string => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, entity: string) => {
  if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(entity[1] === 'x' ? 2 : 1), entity[1] === 'x' ? 16 : 10));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity];
});
const paragraphPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu;
const textPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu;
const wordXml = async (zip: JSZip): Promise<string> => {
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml || xml.length > 8_000_000) throw new Error('Word 正文缺失或过大。');
  return xml;
};
export const readWordParagraphs = async (bytes: Uint8Array): Promise<string[]> => {
  const zip = await loadOffice(bytes);
  const xml = await wordXml(zip);
  return [...xml.matchAll(paragraphPattern)].map((paragraph) => [...paragraph[0].matchAll(textPattern)].map((t) => unescapeXml(t[1])).join(''));
};
export const editWord = async (bytes: Uint8Array, edits: Extract<ArtifactEdits, { kind: 'docx' }>): Promise<Buffer> => {
  const zip = await loadOffice(bytes);
  const xml = await wordXml(zip);
  const changes = new Map(edits.paragraphs.map((p) => [p.index, p.text]));
  let index = -1;
  const result = xml.replace(paragraphPattern, (paragraph) => {
    index += 1;
    const value = changes.get(index);
    if (value === undefined) return paragraph;
    changes.delete(index);
    const texts = [...paragraph.matchAll(textPattern)];
    if (!texts.length) return paragraph.replace('</w:p>', `<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`);
    let offset = 0;
    let current = 0;
    return paragraph.replace(textPattern, () => {
      const length = unescapeXml(texts[current][1]).length;
      const part = current === texts.length - 1 ? value.slice(offset) : value.slice(offset, offset + length);
      offset += length; current += 1;
      return `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
    });
  });
  if (changes.size) throw new Error('文档段落已变化，请重新读取。');
  zip.file('word/document.xml', result);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

export const readWorkbook = async (bytes: Uint8Array): Promise<ArtifactSheet[]> => {
  const zip = await loadOffice(bytes);
  let repaired = false;
  const declaration = /<\?xml\b[^?]*\?>/gu;
  for (const name of Object.keys(zip.files).filter((file) => /(?:\.xml|\.rels)$/iu.test(file))) {
    const source = await zip.file(name)?.async('string');
    if (!source) continue;
    const matches = [...source.matchAll(declaration)];
    if (matches.length <= 1 || matches.slice(1).every((match) => match.index === undefined)) continue;
    const normalized = source.replace(declaration, (match, offset: number) => offset === matches[0]?.index ? match : '');
    if (normalized !== source) {
      zip.file(name, normalized);
      repaired = true;
    }
  }
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  const readable = repaired ? await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : bytes;
  await workbook.xlsx.load(readable as never);
  return workbook.worksheets.map((sheet) => {
    const height = Math.min(Math.max(sheet.rowCount, 20), 500);
    const width = Math.min(Math.max(sheet.columnCount, 8), 50);
    return {
      id: sheet.id, name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount,
      truncated: sheet.rowCount > height || sheet.columnCount > width,
      rows: Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => {
        const cell = sheet.getCell(r + 1, c + 1);
        const formula = cell.formula;
        const fill = cell.fill;
        return {
          address: cell.address, readOnly: cell.isMerged && cell.master.address !== cell.address, text: formula ? (cell.result === undefined ? `=${formula}` : String(cell.result)) : cell.text,
          ...(formula ? { formula } : {}),
          ...(cell.font?.bold ? { bold: true } : {}),
          ...(cell.font?.color?.argb ? { color: `#${cell.font.color.argb.slice(-6)}` } : {}),
          ...(fill?.type === 'pattern' && fill.fgColor?.argb ? { background: `#${fill.fgColor.argb.slice(-6)}` } : {}),
        };
      })),
    };
  });
};

const array = <T>(value: T | T[]): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const columnIndex = (address: string): number => [...(address.match(/^[A-Z]+/u)?.[0] ?? '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const editWorkbook = async (bytes: Uint8Array, edits: Extract<ArtifactEdits, { kind: 'xlsx' }>): Promise<Buffer> => {
  const zip = await loadOffice(bytes);
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const relationsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !relationsXml) throw new Error('工作簿结构不完整。');
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const sheets = array<{ '@_sheetId': string; '@_id': string }>(parser.parse(workbookXml).workbook.sheets.sheet);
  const relations = array<{ '@_Id': string; '@_Target': string }>(parser.parse(relationsXml).Relationships.Relationship);
  const changes = new Map<string, string>();
  for (const change of edits.cells) {
    const rowNumber = Number(change.address.match(/\d+$/u)?.[0]);
    if (columnIndex(change.address) > 16384 || rowNumber > 1048576) throw new Error('单元格超出 Excel 范围。');
    const sheet = sheets.find((s) => Number(s['@_sheetId']) === change.sheetId);
    const target = relations.find((r) => r['@_Id'] === sheet?.['@_id'])?.['@_Target'];
    if (!target || target.includes('..') || target.includes('://')) throw new Error('找不到工作表。');
    const file = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    let xml = changes.get(file) ?? await zip.file(file)?.async('string');
    if (!xml) throw new Error('工作表内容缺失。');
    const pattern = new RegExp(`<c\\b(?=[^>]*\\br="${change.address}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`, 'u');
    const old = xml.match(pattern)?.[0];
    if (old && /<f\b[^>]*\bt="(?:shared|array)"/u.test(old)) throw new Error('共享或数组公式请使用 Excel 编辑，避免破坏关联单元格。');
    const style = old?.match(/\bs="(\d+)"/u)?.[1];
    const attrs = `r="${change.address}"${style ? ` s="${style}"` : ''}`;
    const value = change.text;
    const numeric = value.trim() !== '' && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) && Number.isFinite(Number(value));
    const cell = value.startsWith('=') ? `<c ${attrs}><f>${escapeXml(value.slice(1))}</f></c>`
      : numeric ? `<c ${attrs}><v>${Number(value)}</v></c>`
      : `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    if (old) xml = xml.replace(pattern, cell);
    else {
      const rowPattern = new RegExp(`<row\\b(?=[^>]*\\br="${rowNumber}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/row>)`, 'u');
      const row = xml.match(rowPattern)?.[0];
      if (row) {
        const expanded = row.endsWith('/>') ? `${row.slice(0, -2)}></row>` : row;
        const later = [...expanded.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"/gu)].find((c) => columnIndex(c[1]) > columnIndex(change.address));
        const at = later?.index ?? expanded.lastIndexOf('</row>');
        xml = xml.replace(rowPattern, `${expanded.slice(0, at)}${cell}${expanded.slice(at)}`);
      } else {
        if (/<sheetData\s*\/>/u.test(xml)) xml = xml.replace(/<sheetData\s*\/>/u, '<sheetData></sheetData>');
        const later = [...xml.matchAll(/<row\b[^>]*\br="(\d+)"/gu)].find((r) => Number(r[1]) > rowNumber);
        const at = later?.index ?? xml.indexOf('</sheetData>');
        if (at < 0) throw new Error('工作表结构不支持此修改。');
        xml = `${xml.slice(0, at)}<row r="${rowNumber}">${cell}</row>${xml.slice(at)}`;
      }
    }
    // Let readers derive the used range again after inserting a cell.
    xml = xml.replace(/<dimension\b[^>]*\/>/u, '');
    changes.set(file, xml);
  }
  for (const [file, xml] of changes) zip.file(file, xml);
  // Preserve the OOXML package, charts, styles and relationships; only edit cells.
  // Cached formula results are invalid after data changes. Excel recalculates on open.
  for (const file of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/[^/]+\.xml$/u.test(f))) {
    const xml = await zip.file(file)?.async('string');
    if (!xml) continue;
    zip.file(file, xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/gu, (cell) => /<f\b/u.test(cell) ? cell.replace(/<v\b[^>]*>[\s\S]*?<\/v>/gu, '') : cell));
  }
  const calc = '<calcPr fullCalcOnLoad="1" forceFullCalc="1"/>';
  zip.file('xl/workbook.xml', /<calcPr\b/u.test(workbookXml) ? workbookXml.replace(/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr>)/u, calc) : workbookXml.replace('</workbook>', `${calc}</workbook>`));
  zip.remove('xl/calcChain.xml');
  zip.file('xl/_rels/workbook.xml.rels', relationsXml.replace(/<Relationship\b[^>]*Type="[^"]*\/calcChain"[^>]*\/>/gu, ''));
  const contentTypes = await zip.file('[Content_Types].xml')?.async('string');
  if (contentTypes) zip.file('[Content_Types].xml', contentTypes.replace(/<Override\b[^>]*PartName="\/xl\/calcChain.xml"[^>]*\/>/gu, ''));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};
