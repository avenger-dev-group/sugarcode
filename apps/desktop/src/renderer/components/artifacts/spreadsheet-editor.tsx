import { ArrowDownToLine, ArrowRightToLine, Calculator, ClipboardPaste, Copy, Eraser } from 'lucide-react';
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ClipboardEvent, type KeyboardEvent, type PointerEvent, type UIEvent,
} from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import type { ArtifactDocument, ArtifactEdits, ArtifactSheet } from '@/shared/artifacts';

import {
  cellAddress, columnLabel, normalizeRange, parseClipboardGrid,
  pointsInRange, rangeLabel, rangeSize,
  type SpreadsheetPoint, type SpreadsheetRange,
} from './spreadsheet-selection';
import { createSpreadsheetFormulaEvaluator, spreadsheetFormulaCatalog } from './spreadsheet-formula';

type XlsxEdits = Extract<ArtifactEdits, { kind: 'xlsx' }>;
type CellUpdate = Readonly<{ address: string; text: string }>;

const ROW_HEIGHT = 28;
const OVERSCAN_ROWS = 8;
const MAX_CELL_EDITS = 10_000;

const pointEqual = (left: SpreadsheetPoint, right: SpreadsheetPoint): boolean =>
  left.row === right.row && left.column === right.column;

const insideRange = (point: SpreadsheetPoint, range: SpreadsheetRange): boolean => {
  const bounds = normalizeRange(range);
  return point.row >= bounds.top && point.row <= bounds.bottom &&
    point.column >= bounds.left && point.column <= bounds.right;
};

const clampPoint = (point: SpreadsheetPoint, sheet: ArtifactSheet): SpreadsheetPoint => ({
  row: Math.max(0, Math.min(sheet.rows.length - 1, point.row)),
  column: Math.max(0, Math.min((sheet.rows[0]?.length ?? 1) - 1, point.column)),
});

export const SpreadsheetEditor = ({ document, changes, onChange }: {
  document: ArtifactDocument;
  changes: XlsxEdits | undefined;
  onChange: (edits: ArtifactEdits) => void;
}) => {
  const [sheetId, setSheetId] = useState(document.sheets?.[0]?.id);
  const sheet = document.sheets?.find((candidate) => candidate.id === sheetId) ?? document.sheets?.[0];
  if (!sheet) return <div className="p-6 text-sm text-secondary">工作簿中没有工作表。</div>;
  return <SpreadsheetSheet key={sheet.id} document={document} sheet={sheet} changes={changes} onChange={onChange} onSelectSheet={setSheetId} />;
};

const SpreadsheetSheet = ({ document, sheet, changes, onChange, onSelectSheet }: {
  document: ArtifactDocument;
  sheet: ArtifactSheet;
  changes: XlsxEdits | undefined;
  onChange: (edits: ArtifactEdits) => void;
  onSelectSheet: (sheetId: number) => void;
}) => {
  const [selection, setSelection] = useState<SpreadsheetRange>({ anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } });
  const [editing, setEditing] = useState(false);
  const [editorValue, setEditorValue] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 320 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const cellEditorRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const scrollFrame = useRef<number | undefined>(undefined);
  const dragFrame = useRef<number | undefined>(undefined);
  const pendingDragPoint = useRef<SpreadsheetPoint | undefined>(undefined);

  const rowCount = sheet.rows.length;
  const columnCount = sheet.rows[0]?.length ?? 0;
  const active = clampPoint(selection.focus, sheet);
  const activeAddress = cellAddress(active);
  const cellMap = useMemo(() => new Map(sheet.rows.flat().map((cell) => [cell.address, cell])), [sheet.rows]);
  const changeMap = useMemo(() => new Map(changes?.cells.filter((cell) => cell.sheetId === sheet.id).map((cell) => [cell.address, cell.text])), [changes, sheet.id]);
  const formulas = useMemo(() => createSpreadsheetFormulaEvaluator(document, sheet, changes), [changes, document, sheet]);

  const cellInputValue = useCallback((point: SpreadsheetPoint): string => {
    const address = cellAddress(point);
    if (changeMap.has(address)) return changeMap.get(address) ?? '';
    const cell = cellMap.get(address);
    return cell?.formula ? `=${cell.formula}` : cell?.text ?? '';
  }, [cellMap, changeMap]);

  const cellDisplayValue = useCallback((point: SpreadsheetPoint): string => {
    const address = cellAddress(point);
    const raw = changeMap.has(address)
      ? changeMap.get(address) ?? ''
      : cellMap.get(address)?.formula
        ? `=${cellMap.get(address)?.formula}`
        : cellMap.get(address)?.text ?? '';
    return raw.startsWith('=') ? formulas.display(address) : raw;
  }, [cellMap, changeMap, formulas]);

  const applyUpdates = useCallback((updates: readonly CellUpdate[]): boolean => {
    const own = new Map(changes?.cells.filter((cell) => cell.sheetId === sheet.id).map((cell) => [cell.address, cell.text]));
    for (const update of updates) {
      const cell = cellMap.get(update.address);
      if (!cell || cell.readOnly) continue;
      const original = cell.formula ? `=${cell.formula}` : cell.text;
      if (update.text === original) own.delete(update.address);
      else own.set(update.address, update.text);
    }
    const other = (changes?.cells ?? []).filter((cell) => cell.sheetId !== sheet.id);
    if (other.length + own.size > MAX_CELL_EDITS) {
      setNotice(`一次最多暂存 ${MAX_CELL_EDITS.toLocaleString()} 个单元格修改。`);
      return false;
    }
    onChange({ kind: 'xlsx', cells: [...other, ...[...own].map(([address, text]) => ({ sheetId: sheet.id, address, text }))] });
    setNotice('');
    return true;
  }, [cellMap, changes?.cells, onChange, sheet.id]);

  const commitEditor = useCallback((): void => {
    if (!editorDirty) return;
    applyUpdates([{ address: activeAddress, text: editorValue }]);
    setEditorDirty(false);
  }, [activeAddress, applyUpdates, editorDirty, editorValue]);

  useEffect(() => {
    setEditorValue(cellInputValue(active));
    setEditorDirty(false);
  }, [activeAddress, cellInputValue]);

  useEffect(() => {
    const stopDragging = (): void => { dragging.current = false; };
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
    return () => {
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };
  }, []);

  useEffect(() => () => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = (): void => setViewport((current) => ({ scrollTop: element.scrollTop, height: element.clientHeight || current.height }));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) return;
    cellEditorRef.current?.focus();
    cellEditorRef.current?.select();
  }, [editing]);

  const ensureVisible = (point: SpreadsheetPoint): void => {
    const element = scrollRef.current;
    if (!element) return;
    const top = ROW_HEIGHT + point.row * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const left = 40 + point.column * 112;
    const right = left + 112;
    if (top < element.scrollTop + ROW_HEIGHT) element.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
    if (left < element.scrollLeft + 40) element.scrollLeft = Math.max(0, left - 40);
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
  };

  const selectPoint = (point: SpreadsheetPoint, extend = false): void => {
    commitEditor();
    setEditing(false);
    const next = clampPoint(point, sheet);
    setSelection((current) => extend ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next });
    ensureVisible(next);
  };

  const copySelection = async (): Promise<void> => {
    const bounds = normalizeRange(selection);
    const rows: string[] = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      const values: string[] = [];
      for (let column = bounds.left; column <= bounds.right; column += 1) values.push(cellInputValue({ row, column }));
      rows.push(values.join('\t'));
    }
    try {
      await navigator.clipboard.writeText(rows.join('\n'));
      setNotice(`已复制 ${rangeLabel(selection)}`);
    } catch {
      setNotice('无法访问剪贴板，请使用 ⌘/Ctrl+C。');
    }
  };

  const pasteText = (source: string): void => {
    const grid = parseClipboardGrid(source);
    const updates: CellUpdate[] = [];
    for (let row = 0; row < grid.length; row += 1) {
      for (let column = 0; column < (grid[row]?.length ?? 0); column += 1) {
        const point = { row: active.row + row, column: active.column + column };
        if (point.row < rowCount && point.column < columnCount) updates.push({ address: cellAddress(point), text: grid[row]?.[column] ?? '' });
      }
    }
    if (updates.length > MAX_CELL_EDITS) {
      setNotice(`粘贴区域超过 ${MAX_CELL_EDITS.toLocaleString()} 个单元格。`);
      return;
    }
    if (applyUpdates(updates) && updates.length) {
      const last = clampPoint({ row: active.row + grid.length - 1, column: active.column + Math.max(0, ...grid.map((row) => row.length - 1)) }, sheet);
      setSelection({ anchor: active, focus: last });
      setNotice(`已粘贴 ${updates.length.toLocaleString()} 个单元格`);
    }
  };

  const clearSelection = (): void => {
    const points = pointsInRange(selection, MAX_CELL_EDITS);
    if (!points.length && rangeSize(selection) > MAX_CELL_EDITS) {
      setNotice(`选择区域超过 ${MAX_CELL_EDITS.toLocaleString()} 个单元格。`);
      return;
    }
    applyUpdates(points.map((point) => ({ address: cellAddress(point), text: '' })));
  };

  const fillSelection = (direction: 'down' | 'right'): void => {
    const bounds = normalizeRange(selection);
    const points = pointsInRange(selection, MAX_CELL_EDITS);
    if (!points.length) {
      setNotice(`选择区域超过 ${MAX_CELL_EDITS.toLocaleString()} 个单元格。`);
      return;
    }
    const updates = points.filter((point) => direction === 'down' ? point.row > bounds.top : point.column > bounds.left).map((point) => ({
      address: cellAddress(point),
      text: cellInputValue(direction === 'down' ? { row: bounds.top, column: point.column } : { row: point.row, column: bounds.left }),
    }));
    applyUpdates(updates);
  };

  const handlePaste = (event: ClipboardEvent): void => {
    const source = event.clipboardData.getData('text/plain');
    if (!source) return;
    event.preventDefault();
    pasteText(source);
  };

  const handleCellKeyDown = (event: KeyboardEvent, point: SpreadsheetPoint): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'c') {
      event.preventDefault();
      void copySelection();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      if (!cellMap.get(cellAddress(point))?.readOnly) setEditing(true);
      return;
    }
    const offsets: Record<string, SpreadsheetPoint> = {
      ArrowUp: { row: -1, column: 0 }, ArrowDown: { row: 1, column: 0 },
      ArrowLeft: { row: 0, column: -1 }, ArrowRight: { row: 0, column: 1 },
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    selectPoint({ row: point.row + offset.row, column: point.column + offset.column }, event.shiftKey);
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight }));
  };

  const visibleStart = Math.max(0, Math.floor(Math.max(0, viewport.scrollTop - ROW_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS);
  const visibleCount = Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const visibleEnd = Math.min(rowCount, visibleStart + visibleCount);
  const visibleRows = sheet.rows.slice(visibleStart, visibleEnd);
  const topSpacer = visibleStart * ROW_HEIGHT;
  const bottomSpacer = Math.max(0, (rowCount - visibleEnd) * ROW_HEIGHT);
  const bounds = normalizeRange(selection);
  const selectionCount = rangeSize(selection);
  const activeCell = cellMap.get(activeAddress);

  return <div className="flex h-full min-h-0 flex-col" onPaste={handlePaste}>
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b px-2 text-xs">
      <span className="w-20 shrink-0 rounded-md bg-surface px-2 py-1 text-center font-mono text-secondary">{rangeLabel(selection)}</span>
      <span className="text-tertiary">ƒx</span>
      <input className="h-8 min-w-0 flex-1 bg-transparent px-1 outline-none" readOnly={activeCell?.readOnly} aria-label="单元格内容或公式" value={editorValue}
        onChange={(event) => { setEditorValue(event.target.value); setEditorDirty(true); }} onBlur={commitEditor}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commitEditor(); selectPoint({ row: active.row + 1, column: active.column }); }
          else if (event.key === 'Escape') { setEditorValue(cellInputValue(active)); setEditorDirty(false); }
        }} />
    </div>
    <div className="flex min-h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-surface/25 px-2">
      <Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={() => void copySelection()}><Copy aria-hidden="true" />复制</Button>
      <Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={() => { void navigator.clipboard.readText().then(pasteText).catch(() => setNotice('请在目标单元格使用 ⌘/Ctrl+V。')); }}><ClipboardPaste aria-hidden="true" />粘贴</Button>
      <Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={clearSelection}><Eraser aria-hidden="true" />清空</Button>
      <Popover open={formulaOpen} onOpenChange={setFormulaOpen}>
        <PopoverTrigger asChild><Button type="button" size="xs" variant="ghost" className="shrink-0"><Calculator aria-hidden="true" />函数</Button></PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <p className="px-2 pb-2 text-[11px] leading-4 text-secondary">插入常用公式；引用单元格变化后，结果会在表格中即时重算。</p>
          <div className="grid grid-cols-2 gap-1">{spreadsheetFormulaCatalog.map(([label, name, template]) => <button key={name} type="button"
            className="rounded-lg px-2 py-2 text-left hover:bg-surface" onClick={() => { setEditorValue(template); setEditorDirty(true); setEditing(true); setFormulaOpen(false); }}>
            <span className="block text-xs font-medium">{label}</span><span className="mt-0.5 block font-mono text-[10px] text-tertiary">{name}</span>
          </button>)}</div>
          <p className="border-t px-2 pt-2 text-[10px] leading-4 text-tertiary">另支持 COUNT、COUNTA、SUMPRODUCT、AVERAGEIF、VLOOKUP、XLOOKUP、AND、OR、NOT、IFERROR、ABS、SQRT、POWER、MOD、ROUNDUP、ROUNDDOWN、CONCAT、LEN、LEFT、RIGHT、MID、LOWER、UPPER、TRIM。</p>
        </PopoverContent>
      </Popover>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button type="button" size="xs" variant="ghost" className="shrink-0" disabled={bounds.top === bounds.bottom} onClick={() => fillSelection('down')}><ArrowDownToLine aria-hidden="true" />向下填充</Button>
      <Button type="button" size="xs" variant="ghost" className="shrink-0" disabled={bounds.left === bounds.right} onClick={() => fillSelection('right')}><ArrowRightToLine aria-hidden="true" />向右填充</Button>
      <span className="ml-auto whitespace-nowrap px-1 font-mono text-[10px] text-tertiary">{selectionCount > 1 ? `${selectionCount.toLocaleString()} 个单元格` : activeAddress}</span>
    </div>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-background" onScroll={handleScroll}>
      <table className="border-separate border-spacing-0 text-xs" role="grid" aria-label={`${sheet.name} 工作表`}>
        <thead className="sticky top-0 z-10"><tr>
          <th className="sticky left-0 z-20 h-7 min-w-10 border-b border-r bg-surface"><button type="button" className="h-full w-full hover:bg-surface-hover" aria-label="选择整个工作表" onClick={() => setSelection({ anchor: { row: 0, column: 0 }, focus: { row: rowCount - 1, column: columnCount - 1 } })} /></th>
          {sheet.rows[0]?.map((_, column) => <th key={column} className="h-7 min-w-28 border-b border-r bg-surface p-0 text-center font-normal text-tertiary"><button type="button" className="h-full w-full hover:bg-surface-hover" onClick={() => setSelection({ anchor: { row: 0, column }, focus: { row: rowCount - 1, column } })}>{columnLabel(column)}</button></th>)}
        </tr></thead>
        <tbody>
          {topSpacer ? <tr aria-hidden="true"><td colSpan={columnCount + 1} style={{ height: topSpacer }} /></tr> : null}
          {visibleRows.map((row, offset) => {
            const rowIndex = visibleStart + offset;
            return <tr key={rowIndex} style={{ height: ROW_HEIGHT }}>
              <th className="sticky left-0 z-[1] h-7 min-w-10 border-b border-r bg-surface p-0 text-center font-mono font-normal text-tertiary"><button type="button" className="h-full w-full hover:bg-surface-hover" onClick={() => setSelection({ anchor: { row: rowIndex, column: 0 }, focus: { row: rowIndex, column: columnCount - 1 } })}>{rowIndex + 1}</button></th>
              {row.map((cell, column) => {
                const point = { row: rowIndex, column };
                const isActive = pointEqual(point, active);
                const selected = insideRange(point, selection);
                const changed = changeMap.has(cell.address);
                return <td key={cell.address} role="gridcell" aria-selected={selected}
                  className={`relative h-7 min-w-28 border-b border-r p-0 ${selected ? 'bg-brand/8' : ''} ${isActive ? 'ring-2 ring-inset ring-ring' : ''}`}
                  style={{ backgroundColor: selected ? undefined : cell.background, color: cell.color, fontWeight: cell.bold ? 600 : undefined }}
                  onPointerDown={(event: PointerEvent) => { if (event.button !== 0) return; event.preventDefault(); commitEditor(); dragging.current = true; pendingDragPoint.current = undefined; setEditing(false); setSelection({ anchor: point, focus: point }); }}
                  onPointerEnter={() => {
                    if (!dragging.current) return;
                    pendingDragPoint.current = point;
                    if (dragFrame.current !== undefined) return;
                    dragFrame.current = requestAnimationFrame(() => {
                      const focus = pendingDragPoint.current;
                      dragFrame.current = undefined;
                      if (focus) setSelection((current) => ({ anchor: current.anchor, focus }));
                    });
                  }}
                  onDoubleClick={() => { if (!cell.readOnly) setEditing(true); }}>
                  {editing && isActive ? <input ref={cellEditorRef} className="h-7 w-28 bg-background px-2 outline-none" aria-label={`${sheet.name} ${cell.address}`} value={editorValue}
                    onPointerDown={(event) => event.stopPropagation()} onChange={(event) => { setEditorValue(event.target.value); setEditorDirty(true); }}
                    onBlur={() => { commitEditor(); setEditing(false); }} onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitEditor(); setEditing(false); selectPoint({ row: active.row + 1, column: active.column }); }
                      if (event.key === 'Escape') { event.preventDefault(); setEditorValue(cellInputValue(active)); setEditorDirty(false); setEditing(false); }
                    }} /> : <button type="button" data-address={cell.address} tabIndex={isActive ? 0 : -1}
                    className={`block h-7 w-28 truncate px-2 text-left outline-none ${cell.readOnly ? 'cursor-default opacity-75' : ''}`}
                    aria-label={`${sheet.name} ${cell.address}`} onFocus={() => { if (!isActive) selectPoint(point); }} onKeyDown={(event) => handleCellKeyDown(event, point)}>
                    {cellDisplayValue(point)}{changed ? <span className="absolute right-0 top-0 size-1.5 bg-amber-500" aria-label="已修改" /> : null}
                  </button>}
                </td>;
              })}
            </tr>;
          })}
          {bottomSpacer ? <tr aria-hidden="true"><td colSpan={columnCount + 1} style={{ height: bottomSpacer }} /></tr> : null}
        </tbody>
      </table>
    </div>
    <div className="flex shrink-0 items-center gap-1 overflow-auto border-t bg-surface/30 px-2 py-1.5">{document.sheets?.map((candidate) => <button key={candidate.id} type="button" className={`shrink-0 rounded-md px-3 py-1.5 text-xs ${candidate.id === sheet.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-secondary hover:text-foreground'}`} onClick={() => { commitEditor(); onSelectSheet(candidate.id); }}>{candidate.name}</button>)}</div>
    <div className="flex min-h-8 shrink-0 items-center gap-2 border-t px-3 py-1.5 text-[10px] leading-4 text-tertiary"><span className="min-w-0 flex-1 truncate">{notice || '拖动框选；Shift+方向键扩展；Enter 编辑；支持 TSV 批量复制粘贴。'}</span>{sheet.truncated ? <span className="shrink-0">显示前 500 行、50 列</span> : null}</div>
  </div>;
};
