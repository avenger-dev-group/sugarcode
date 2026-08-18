import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectTurnKnowledgeCitations,
  mergeConversationKnowledgeCitations,
} from '../../../src/renderer/components/thread/knowledge-citations.ts';
import { splitKnowledgeCitationText } from '../../../src/renderer/components/agent/knowledge-citation-text.ts';
import type {
  ConversationActivity,
  ConversationKnowledgeCitation,
} from '../../../src/shared/conversation.ts';

const citation = (
  label: string,
  documentId: string,
): ConversationKnowledgeCitation => ({
  citation: label,
  knowledgeBaseId: `kb_${'1'.repeat(32)}`,
  knowledgeBaseName: '产品规范',
  documentId,
  fileName: `${documentId}.md`,
  relativePath: `${documentId}.md`,
  content: documentId,
});

const activity = (
  id: string,
  citations: readonly ConversationKnowledgeCitation[],
): ConversationActivity => ({
  type: 'knowledge',
  activity: {
    id,
    callId: `${id}:call`,
    operation: 'search',
    query: 'fixture',
    callStatus: 'completed',
    result: {
      id: `${id}:result`,
      status: 'completed',
      outcome: {
        type: 'success',
        mode: 'fullText',
        matches: citations.length,
        knowledgeBases: [],
        citations,
      },
    },
  },
});

test('agent citations use the latest matching K label and retain deterministic order', () => {
  const oldK1 = citation('K1', `kd_${'1'.repeat(32)}`);
  const newK1 = citation('K1', `kd_${'2'.repeat(32)}`);
  const k2 = citation('K2', `kd_${'3'.repeat(32)}`);

  assert.deepEqual(
    collectTurnKnowledgeCitations([
      activity('first', [oldK1]),
      activity('second', [k2, newK1]),
    ]),
    [newK1, k2],
  );
});

test('a later Turn can resolve a citation emitted by an earlier Turn in the same conversation', () => {
  const earlierK1 = citation('K1', `kd_${'4'.repeat(32)}`);
  const conversationCitations = mergeConversationKnowledgeCitations(
    [],
    collectTurnKnowledgeCitations([activity('first', [earlierK1])]),
  );
  const available = new Map(
    conversationCitations.map((entry) => [entry.citation, entry] as const),
  );
  assert.deepEqual(
    splitKnowledgeCitationText('来源：[K1] 公司信息.txt', available),
    [
      { type: 'text', value: '来源：' },
      { type: 'citation', label: 'K1' },
      { type: 'text', value: ' 公司信息.txt' },
    ],
  );
});
