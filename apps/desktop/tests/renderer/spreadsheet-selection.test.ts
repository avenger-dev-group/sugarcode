import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellAddress,
  columnLabel,
  normalizeRange,
  parseClipboardGrid,
  pointsInRange,
  rangeLabel,
} from '../../src/renderer/components/artifacts/spreadsheet-selection.ts';

test('spreadsheet coordinates support Excel columns and reverse selections', () => {
  assert.equal(columnLabel(0), 'A');
  assert.equal(columnLabel(25), 'Z');
  assert.equal(columnLabel(26), 'AA');
  assert.equal(columnLabel(701), 'ZZ');
  assert.equal(cellAddress({ row: 8, column: 27 }), 'AB9');
  const range = { anchor: { row: 3, column: 2 }, focus: { row: 1, column: 0 } };
  assert.deepEqual(normalizeRange(range), { top: 1, bottom: 3, left: 0, right: 2 });
  assert.equal(rangeLabel(range), 'A2:C4');
  assert.equal(pointsInRange(range).length, 9);
});

test('spreadsheet clipboard parsing preserves rectangular text and bounds large work', () => {
  assert.deepEqual(parseClipboardGrid('名称\t数量\r\n笔记本\t15\r\n'), [
    ['名称', '数量'],
    ['笔记本', '15'],
  ]);
  assert.deepEqual(pointsInRange({ anchor: { row: 0, column: 0 }, focus: { row: 200, column: 100 } }), []);
});
