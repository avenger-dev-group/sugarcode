import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { FinishReason } from '@google/genai';
import { ProviderAdapterError } from '../../src/runtime/models/errors.ts';

import {
  createVideoAnalysisTool,
  VideoAnalyzer,
  videoAttachmentReference,
} from '../../src/runtime/video-analysis.ts';
import type { RuntimeAssetDescriptor } from '../../src/runtime/protocol.ts';

class VideoFixtureLlm extends BaseLlm {
  requests: LlmRequest[] = [];

  constructor() {
    super({ model: 'video-fixture' });
  }

  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    this.requests.push(request);
    yield {
      content: {
        role: 'model',
        parts: [{ text: 'A person opens the app and submits a login form.' }],
      },
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

class VideoRejectingFixtureLlm extends VideoFixtureLlm {
  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse> {
    if ((request.contents[0]?.parts ?? []).some(
      (part) => part.inlineData?.mimeType.startsWith('video/'),
    )) {
      throw new ProviderAdapterError({
        kind: 'invalidRequest',
        retryable: false,
        message: 'Video input is unsupported.',
      });
    }
    yield* super.generateContentAsync(request);
  }
}

const asset: RuntimeAssetDescriptor = {
  assetId: `ast_${'c'.repeat(64)}`,
  sha256: 'c'.repeat(64),
  mediaType: 'video/mp4',
  originalName: 'login-flow.mp4',
  sizeBytes: 3,
  kind: 'video',
};

test('video attachment references expose a scoped tool handle without media bytes', () => {
  const reference = videoAttachmentReference(asset);
  assert.match(reference, /analyze_video/u);
  assert.match(reference, new RegExp(asset.assetId, 'u'));
  assert.doesNotMatch(reference, /base64/iu);
});

test('video analyzer sends inline video, sampling metadata, and caches identical requests', async () => {
  const model = new VideoFixtureLlm();
  const analyzer = new VideoAnalyzer({
    readFile: async () => Buffer.from('mp4'),
  });
  const options = {
    asset,
    path: '/fixture/login-flow.mp4',
    question: 'What workflow is demonstrated?',
    fps: 1,
    analysisModel: {
      profileId: 'video_profile',
      modelId: 'video-fixture',
      displayName: 'Video fixture',
      wireApi: 'openaiChatCompletions',
      imageInput: true,
      model,
    },
    signal: new AbortController().signal,
  } as const;

  assert.deepEqual(await analyzer.analyze(options), {
    analysis: 'A person opens the app and submits a login form.',
    cached: false,
    mode: 'auto',
    transport: 'directVideo',
    nativeSource: 'inline',
    nativeAttempted: true,
    effectiveFps: 1,
    audioIncluded: true,
    audioTransport: 'nativeVideo',
    diarizationIncluded: false,
  });
  assert.deepEqual(await analyzer.analyze(options), {
    analysis: 'A person opens the app and submits a login form.',
    cached: true,
    mode: 'auto',
    transport: 'directVideo',
    nativeSource: 'inline',
    nativeAttempted: true,
    effectiveFps: 1,
    audioIncluded: true,
    audioTransport: 'nativeVideo',
    diarizationIncluded: false,
  });
  assert.equal(model.requests.length, 1);
  const media = model.requests[0]?.contents[0]?.parts?.[1];
  assert.equal(media?.inlineData?.mimeType, 'video/mp4');
  assert.equal(media?.inlineData?.data, 'bXA0');
  assert.equal(media?.partMetadata?.sugarcodeVideoFps, 1);
});

test('video analysis tool validates scope and fps before calling the model', async () => {
  const model = new VideoFixtureLlm();
  const tool = createVideoAnalysisTool({
    assets: [asset],
    analysisModel: {
      profileId: 'video_profile',
      modelId: 'video-fixture',
      displayName: 'Video fixture',
      wireApi: 'openaiChatCompletions',
      imageInput: true,
      model,
    },
    analyzer: new VideoAnalyzer({ readFile: async () => Buffer.from('mp4') }),
    readAsset: () => ({ asset, path: '/fixture/login-flow.mp4' }),
    signal: new AbortController().signal,
  });

  assert.deepEqual(
    await tool.runAsync({
      args: { assetId: `ast_${'d'.repeat(64)}` },
      toolContext: {} as never,
    }),
    { ok: false, error: 'videoNotAvailable' },
  );
  const invalid = await tool.runAsync({
    args: { assetId: asset.assetId, fps: 20 },
    toolContext: {} as never,
  });
  assert.equal((invalid as { error?: string }).error, 'videoAnalysisFailed');
  assert.match((invalid as { message?: string }).message ?? '', /between 0\.1 and 10/u);
  const invalidMode = await tool.runAsync({
    args: { assetId: asset.assetId, mode: 'unknown' },
    toolContext: {} as never,
  });
  assert.equal(
    (invalidMode as { error?: string }).error,
    'videoAnalysisFailed',
  );
  assert.match(
    (invalidMode as { message?: string }).message ?? '',
    /mode is invalid/u,
  );
});

test('large or Anthropic videos fall back to bounded chronological image frames', async () => {
  const model = new VideoFixtureLlm();
  const analyzer = new VideoAnalyzer({
    extractFrames: async () => ({
      durationSeconds: 10,
      effectiveFps: 0.2,
      frames: [
        { data: 'ZnJhbWUx', timestampSeconds: 0 },
        { data: 'ZnJhbWUy', timestampSeconds: 5 },
      ],
    }),
  });
  const result = await analyzer.analyze({
    asset,
    path: '/fixture/login-flow.mp4',
    fps: 1,
    analysisModel: {
      profileId: 'video_profile',
      modelId: 'video-fixture',
      displayName: 'Video fixture',
      wireApi: 'anthropicMessages',
      imageInput: true,
      model,
    },
    signal: new AbortController().signal,
  });
  assert.equal(result.transport, 'extractedFrames');
  assert.equal(result.frameCount, 2);
  assert.equal(result.audioIncluded, false);
  const parts = model.requests[0]?.contents[0]?.parts ?? [];
  assert.match(parts[0]?.text ?? '', /audio is processed separately/u);
  assert.deepEqual(
    parts.slice(1).map((part) => part.inlineData?.mimeType),
    ['image/jpeg', 'image/jpeg'],
  );
});

test('an unsupported native-video extension retries with provider-neutral frames', async () => {
  const model = new VideoRejectingFixtureLlm();
  const analyzer = new VideoAnalyzer({
    readFile: async () => Buffer.from('mp4'),
    extractFrames: async () => ({
      effectiveFps: 1,
      frames: [{ data: 'ZnJhbWU=', timestampSeconds: 0 }],
    }),
  });
  const result = await analyzer.analyze({
    asset,
    path: '/fixture/login-flow.mp4',
    analysisModel: {
      profileId: 'video_profile',
      modelId: 'video-fixture',
      displayName: 'Video fixture',
      wireApi: 'openaiResponses',
      imageInput: true,
      videoInput: 'enabled',
      model,
    },
    signal: new AbortController().signal,
  });
  assert.equal(result.transport, 'extractedFrames');
  assert.equal(result.frameCount, 1);
  assert.equal(result.nativeAttempted, true);
  assert.match(result.nativeFailure ?? '', /unsupported/u);
});

test('published native video uses a provider URL without reading the file inline', async () => {
  const model = new VideoFixtureLlm();
  const analyzer = new VideoAnalyzer({
    readFile: async () => {
      throw new Error('inline read must not run');
    },
  });
  const result = await analyzer.analyze({
    asset: { ...asset, sizeBytes: 40 * 1024 * 1024 },
    path: '/fixture/login-flow.mp4',
    analysisModel: {
      profileId: 'video_profile',
      modelId: 'video-fixture',
      displayName: 'Video fixture',
      wireApi: 'openaiChatCompletions',
      imageInput: true,
      videoInput: 'enabled',
      publisher: {
        publish: async () => ({ uri: 'oss://fixture/login-flow.mp4' }),
      },
      model,
    },
    signal: new AbortController().signal,
  });
  assert.equal(result.transport, 'directVideo');
  assert.equal(result.nativeSource, 'temporaryUrl');
  const media = model.requests[0]?.contents[0]?.parts?.[1];
  assert.equal(media?.fileData?.fileUri, 'oss://fixture/login-flow.mp4');
});

test('meeting mode fuses visual evidence with speaker-attributed audio', async () => {
  const visualModel = new VideoFixtureLlm();
  const audioModel = new (class extends VideoFixtureLlm {
    override async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse> {
      this.requests.push(request);
      yield {
        content: {
          role: 'model',
          parts: [{
            text: JSON.stringify({
              segments: [
                {
                  startSeconds: 1,
                  endSeconds: 2,
                  speaker: 'Speaker 1',
                  text: 'Prepare the release notes.',
                },
                {
                  startSeconds: 3,
                  endSeconds: 4,
                  speaker: 'Speaker 2',
                  text: 'I will send them Friday.',
                },
              ],
            }),
          }],
        },
        partial: false,
        turnComplete: true,
        finishReason: FinishReason.STOP,
      };
    }
  })();
  const analyzer = new VideoAnalyzer({
    extractFrames: async () => ({
      durationSeconds: 10,
      effectiveFps: 0.1,
      frames: [{ data: 'ZnJhbWU=', timestampSeconds: 0 }],
    }),
    extractAudio: async () => ({
      durationSeconds: 10,
      chunks: [{
        data: 'YXVkaW8=',
        mediaType: 'audio/wav',
        startSeconds: 0,
      }],
    }),
  });
  const result = await analyzer.analyze({
    asset,
    path: '/fixture/login-flow.mp4',
    mode: 'meeting',
    analysisModel: {
      profileId: 'video_profile',
      modelId: 'video-fixture',
      displayName: 'Video fixture',
      wireApi: 'anthropicMessages',
      imageInput: true,
      videoInput: 'disabled',
      model: visualModel,
    },
    transcriptionModel: {
      profileId: 'audio_profile',
      modelId: 'audio-fixture',
      displayName: 'Audio fixture',
      model: audioModel,
    },
    signal: new AbortController().signal,
  });
  assert.equal(result.transport, 'hybrid');
  assert.equal(result.audioIncluded, true);
  assert.equal(result.audioTransport, 'extractedAudio');
  assert.equal(result.diarizationIncluded, true);
  assert.equal(result.speakerCount, 2);
  const audioPart = audioModel.requests[0]?.contents[0]?.parts?.[1];
  assert.equal(audioPart?.inlineData?.mimeType, 'audio/wav');
  assert.equal(visualModel.requests.length, 2);
});
