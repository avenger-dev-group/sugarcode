import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpreadsheetFormulaEvaluator } from '../../src/renderer/components/artifacts/spreadsheet-formula.ts';
import type { ArtifactDocument, ArtifactSheet } from '../../src/shared/artifacts.ts';

const sheet: ArtifactSheet = {
  id: 1, name: '销售', rowCount: 3, columnCount: 6, truncated: false,
  rows: [
    ['12', '15', '笔记本', '', '', ''].map((text, index) => ({ address: `${String.fromCharCode(65 + index)}1`, text })),
    ['3', '60', '签字笔', '', '', ''].map((text, index) => ({ address: `${String.fromCharCode(65 + index)}2`, text })),
    ['25', '8', '水杯', '', '', ''].map((text, index) => ({ address: `${String.fromCharCode(65 + index)}3`, text })),
  ],
};
const document: ArtifactDocument = { path: '/tmp/test.xlsx', identity: 'a', revision: '1', kind: 'xlsx', bytes: 1, sheets: [sheet] };

test('spreadsheet formulas calculate arithmetic, ranges, conditions and text', () => {
  const evaluator = createSpreadsheetFormulaEvaluator(document, sheet, { kind: 'xlsx', cells: [
    { sheetId: 1, address: 'D1', text: '=SUM(A1:A3)' },
    { sheetId: 1, address: 'D2', text: '=SUMPRODUCT(A1:A3,B1:B3)' },
    { sheetId: 1, address: 'E1', text: '=IF(D1>50,"高","低")' },
    { sheetId: 1, address: 'E2', text: '=COUNTIF(B1:B3,">10")' },
    { sheetId: 1, address: 'F1', text: '=CONCAT(C1,"：",ROUND(A1*B1,2))' },
  ] });
  assert.equal(evaluator.display('D1'), '40');
  assert.equal(evaluator.display('D2'), '560');
  assert.equal(evaluator.display('E1'), '低');
  assert.equal(evaluator.display('E2'), '2');
  assert.equal(evaluator.display('F1'), '笔记本：180');
});

test('spreadsheet formulas refresh dependencies and contain errors', () => {
  const evaluator = createSpreadsheetFormulaEvaluator(document, sheet, { kind: 'xlsx', cells: [
    { sheetId: 1, address: 'A1', text: '20' },
    { sheetId: 1, address: 'D1', text: '=SUM(A1:A3)' },
    { sheetId: 1, address: 'D2', text: '=IFERROR(1/0,99)' },
    { sheetId: 1, address: 'E1', text: '=E2' },
    { sheetId: 1, address: 'E2', text: '=E1' },
  ] });
  assert.equal(evaluator.display('D1'), '48');
  assert.equal(evaluator.display('D2'), '99');
  assert.equal(evaluator.display('E1'), '#CYCLE!');
});
