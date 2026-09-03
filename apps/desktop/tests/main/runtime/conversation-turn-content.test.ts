import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialTurnContent,
  revisedTurnContent,
} from '../../../src/main/runtime/conversation/turns/content.ts';
import { MAX_CONVERSATION_INPUT_BYTES } from '../../../src/shared/conversation.ts';

const userMessage = {
  text: '$frontend-design\nOriginal request',
  attachments: [
    {
      assetId: `ast_${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'brief.pdf',
      sizeBytes: 1024,
      kind: 'pdf' as const,
      pdfPages: 3,
      previewUrl: 'data:application/pdf;base64,ignored',
    },
  ],
};

test('initial turn content preserves the submitted text', () => {
  assert.deepEqual(initialTurnContent('Hello'), [
    { type: 'text', text: 'Hello' },
  ]);
  assert.deepEqual(initialTurnContent(''), []);
});

test('revised turn content preserves references and durable attachment fields', () => {
  assert.deepEqual(revisedTurnContent(userMessage, 'Revised request'), [
    { type: 'text', text: '$frontend-design\nRevised request' },
    {
      type: 'asset',
      asset: {
        assetId: `ast_${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        mediaType: 'application/pdf',
        originalName: 'brief.pdf',
        sizeBytes: 1024,
        kind: 'pdf',
        pdfPages: 3,
      },
    },
  ]);
});

test('revised turn content preserves stable knowledge IDs as optional metadata', () => {
  assert.deepEqual(
    revisedTurnContent(
      {
        text: '@知识库产品规范\nOriginal request',
        attachments: [],
        knowledgeReferences: [{
          knowledgeBaseId: `kb_${'1'.repeat(32)}`,
          name: '产品规范',
        }],
      },
      'Revised request',
    ),
    [
      { type: 'text', text: '@知识库产品规范\nRevised request' },
      {
        type: 'knowledgeReferences',
        references: [{
          knowledgeBaseId: `kb_${'1'.repeat(32)}`,
          name: '产品规范',
        }],
      },
    ],
  );
});

test('revised turn content rejects the complete restored input over the limit', () => {
  assert.equal(
    revisedTurnContent(
      { text: '$frontend-design', attachments: [] },
      'a'.repeat(MAX_CONVERSATION_INPUT_BYTES),
    ),
    undefined,
  );
});

test('revised turn content permits empty text only when an attachment remains', () => {
  assert.equal(
    revisedTurnContent({ text: '', attachments: [] }, '   '),
    undefined,
  );
  assert.deepEqual(
    revisedTurnContent({ text: '', attachments: userMessage.attachments }, ''),
    [
      {
        type: 'asset',
        asset: {
          assetId: `ast_${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          mediaType: 'application/pdf',
          originalName: 'brief.pdf',
          sizeBytes: 1024,
          kind: 'pdf',
          pdfPages: 3,
        },
      },
    ],
  );
});
