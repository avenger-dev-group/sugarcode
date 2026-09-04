export type SpreadsheetPoint = Readonly<{ row: number; column: number }>;
export type SpreadsheetRange = Readonly<{
  anchor: SpreadsheetPoint;
  focus: SpreadsheetPoint;
}>;

export const columnLabel = (index: number): string => {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
};

export const cellAddress = (point: SpreadsheetPoint): string =>
  `${columnLabel(point.column)}${point.row + 1}`;

export const normalizeRange = (range: SpreadsheetRange) => ({
  top: Math.min(range.anchor.row, range.focus.row),
  bottom: Math.max(range.anchor.row, range.focus.row),
  left: Math.min(range.anchor.column, range.focus.column),
  right: Math.max(range.anchor.column, range.focus.column),
});

export const rangeLabel = (range: SpreadsheetRange): string => {
  const bounds = normalizeRange(range);
  const first = cellAddress({ row: bounds.top, column: bounds.left });
  const last = cellAddress({ row: bounds.bottom, column: bounds.right });
  return first === last ? first : `${first}:${last}`;
};

export const rangeSize = (range: SpreadsheetRange): number => {
  const bounds = normalizeRange(range);
  return (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
};

export const pointsInRange = (
  range: SpreadsheetRange,
  limit = 10_000,
): SpreadsheetPoint[] => {
  const bounds = normalizeRange(range);
  const size = rangeSize(range);
  if (size > limit) return [];
  const points: SpreadsheetPoint[] = [];
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    for (let column = bounds.left; column <= bounds.right; column += 1) {
      points.push({ row, column });
    }
  }
  return points;
};

export const parseClipboardGrid = (source: string): string[][] => {
  const normalized = source.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
  return normalized.split('\n').map((row) => row.split('\t'));
};
