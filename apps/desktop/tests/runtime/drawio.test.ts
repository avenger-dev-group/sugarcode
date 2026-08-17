import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drawioAddPatch,
  isDrawioPath,
  normalizeDrawioXml,
  validateDrawioXml,
} from '../../src/runtime/tools/drawio.ts';

const diagram = [
  '<mxGraphModel>',
  '  <root>',
  '    <mxCell id="0"/>',
  '    <mxCell id="1" parent="0"/>',
  '    <mxCell id="start" value="开始" vertex="1" parent="1"><mxGeometry x="20" y="20" width="100" height="40" as="geometry"/></mxCell>',
  '    <mxCell id="finish" value="结束" vertex="1" parent="1"><mxGeometry x="180" y="20" width="100" height="40" as="geometry"/></mxCell>',
  '    <mxCell id="edge" edge="1" source="start" target="finish" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>',
  '  </root>',
  '</mxGraphModel>',
].join('\n');

test('Draw.io generation accepts native XML and reports its structure', () => {
  assert.deepEqual(validateDrawioXml(diagram), {
    ok: true,
    xml: `${diagram}\n`,
    cells: 5,
    edges: 1,
  });
});

test('Draw.io generation removes a complete Markdown fence before validation', () => {
  assert.equal(normalizeDrawioXml(`\n\`\`\`xml\n${diagram}\n\`\`\`\n`), diagram);
});

test('Draw.io generation rejects unsafe roots, entities, and duplicate cell ids', () => {
  assert.equal(validateDrawioXml('<svg/>').ok, false);
  assert.equal(
    validateDrawioXml(`<!DOCTYPE x [<!ENTITY y "z">]>${diagram}`).ok,
    false,
  );
  assert.equal(
    validateDrawioXml(diagram.replace('id="finish"', 'id="start"')).ok,
    false,
  );
});

test('Draw.io artifacts require a safe workspace-relative .drawio path', () => {
  assert.equal(isDrawioPath('diagrams/leave-approval.drawio'), true);
  assert.equal(isDrawioPath('../leave-approval.drawio'), false);
  assert.equal(isDrawioPath('/tmp/leave-approval.drawio'), false);
  assert.equal(isDrawioPath('diagrams/leave-approval.xml'), false);
});

test('Draw.io XML is encoded as a bounded Add File patch', () => {
  const patch = drawioAddPatch('diagrams/example.drawio', `${diagram}\n`);
  assert.match(patch, /^\*\*\* Begin Patch\n\*\*\* Add File: diagrams\/example\.drawio\n/u);
  assert.match(patch, /\n\+<mxGraphModel>\n/u);
  assert.match(patch, /\n\*\*\* End Patch$/u);
});
