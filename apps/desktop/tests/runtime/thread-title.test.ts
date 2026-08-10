import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason } from '@google/genai';

import {
  generateThreadTitle,
  normalizeGeneratedTitle,
  titleSourceFromContent,
} from '../../src/runtime/thread-title.ts';

class TitleFixtureLlm extends BaseLlm {
  request: LlmRequest | null = null;

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.request = request;
    yield {
      content: {
        role: 'model',
        parts: [
          { text: 'Internal title reasoning', thought: true },
          { text: '## “修复会话标题生成。”' },
        ],
      },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled in this fixture.'));
  }
}

test('title source uses task-bearing text and attachment names', () => {
  assert.equal(
    titleSourceFromContent([
      { type: 'text', text: '请检查项目并修复会话标题' },
      {
        type: 'asset',
        asset: {
          assetId: `ast_${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          mediaType: 'text/plain',
          originalName: 'requirements.txt',
          sizeBytes: 12,
          kind: 'text',
        },
      },
    ]),
    '请检查项目并修复会话标题\nAttachment: requirements.txt',
  );
  assert.equal(
    titleSourceFromContent([{ type: 'text', text: '你好！' }]),
    null,
  );
});

test('generated titles are cleaned, bounded, and reject generic metadata', () => {
  assert.equal(normalizeGeneratedTitle('## “修复会话标题生成。”\nextra'), '修复会话标题生成');
  assert.equal(normalizeGeneratedTitle('改'.repeat(60)), '改'.repeat(48));
  assert.equal(normalizeGeneratedTitle('新对话'), null);
  assert.equal(
    normalizeGeneratedTitle('00000000-0000-7000-8000-000000000001'),
    null,
  );
});

test('title generation is a bounded tool-free metadata request', async () => {
  const model = new TitleFixtureLlm({ model: 'fixture-model' });
  assert.equal(
    await generateThreadTitle(model, '修复左侧会话标题'),
    '修复会话标题生成',
  );
  assert.equal(model.request?.config?.maxOutputTokens, 64);
  assert.deepEqual(model.request?.toolsDict, {});
  const instruction = model.request?.config?.systemInstruction;
  assert.match(JSON.stringify(instruction), /untrusted material/u);
});
