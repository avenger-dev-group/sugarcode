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
  createImageAnalysisTool,
  ImageAnalyzer,
  imageAttachmentReference,
} from '../../src/runtime/media/analysis.ts';
import type { RuntimeAssetDescriptor } from '../../src/runtime/contracts/protocol.ts';

class ImageFixtureLlm extends BaseLlm {
  requests: LlmRequest[] = [];

  constructor() {
    super({ model: 'vision-fixture' });
  }

  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.requests.push(request);
    yield {
      content: { role: 'model', parts: [{ text: 'A login form is visible.' }] },
      partial: true,
    };
    yield {
      content: { role: 'model', parts: [{ text: 'A login form is visible.' }] },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
    };
  }

  connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    void _request;
    return Promise.reject(new Error('Live mode is disabled.'));
  }
}

const asset: RuntimeAssetDescriptor = {
  assetId: `ast_${'a'.repeat(64)}`,
  sha256: 'a'.repeat(64),
  mediaType: 'image/png',
  originalName: 'login.png',
  sizeBytes: 12,
  kind: 'image',
};

test('image attachment references expose a bounded tool handle, not image bytes', () => {
  const reference = imageAttachmentReference(asset);
  assert.match(reference, /analyze_image/u);
  assert.match(reference, new RegExp(asset.assetId, 'u'));
  assert.doesNotMatch(reference, /base64/iu);
});

test('image analyzer sends inline media and caches identical analysis requests', async () => {
  const model = new ImageFixtureLlm();
  const analyzer = new ImageAnalyzer();
  const options = {
    asset,
    data: 'cG5n',
    question: 'What interface is visible?',
    analysisModel: {
      profileId: 'vision_profile',
      modelId: 'vision-fixture',
      displayName: 'Vision fixture',
      model,
    },
    signal: new AbortController().signal,
  } as const;

  assert.deepEqual(await analyzer.analyze(options), {
    analysis: 'A login form is visible.',
    cached: false,
  });
  assert.deepEqual(await analyzer.analyze(options), {
    analysis: 'A login form is visible.',
    cached: true,
  });
  assert.equal(model.requests.length, 1);
  assert.equal(
    model.requests[0]?.contents[0]?.parts?.[1]?.inlineData?.mimeType,
    'image/png',
  );
});

test('image analysis tool rejects assets outside its frozen conversation scope', async () => {
  const tool = createImageAnalysisTool({
    assets: [asset],
    analyzer: new ImageAnalyzer(),
    readAsset: () => {
      throw new Error('Unexpected asset read.');
    },
    signal: new AbortController().signal,
  });

  assert.deepEqual(
    await tool.runAsync({
      args: { assetId: `ast_${'b'.repeat(64)}` },
      toolContext: {} as never,
    }),
    { ok: false, error: 'imageNotAvailable' },
  );
});
