import type { Part } from '@google/genai';
import { readFile } from 'node:fs/promises';

import type { ModelCapabilityMode, ModelWireApi } from '../../../shared/model-config.ts';
import type { RuntimeAssetDescriptor } from '../../contracts/protocol.ts';
import type { TemporaryMediaPublisher } from '../temporary-media.ts';

export const MAX_INLINE_VIDEO_BYTES = 25 * 1024 * 1024;

export type NativeVideoPreparation =
  | Readonly<{
      available: true;
      part: Part;
      source: 'inline' | 'temporaryUrl';
    }>
  | Readonly<{
      available: false;
      reason:
        | 'protocolUnsupported'
        | 'capabilityDisabled'
        | 'inlineLimitExceeded';
    }>;

const nativeVideoSupported = (
  wireApi: ModelWireApi,
  videoInput: ModelCapabilityMode,
): boolean => {
  if (videoInput === 'disabled' || wireApi === 'anthropicMessages') {
    return false;
  }
  return wireApi === 'openaiChatCompletions' || videoInput === 'enabled';
};

export const prepareNativeVideo = async (options: Readonly<{
  asset: RuntimeAssetDescriptor;
  path: string;
  fps: number;
  modelId: string;
  wireApi: ModelWireApi;
  videoInput: ModelCapabilityMode;
  publisher?: TemporaryMediaPublisher;
  readLocalFile?: (filePath: string) => Promise<Buffer>;
  signal: AbortSignal;
}>): Promise<NativeVideoPreparation> => {
  if (options.videoInput === 'disabled') {
    return { available: false, reason: 'capabilityDisabled' };
  }
  if (!nativeVideoSupported(options.wireApi, options.videoInput)) {
    return { available: false, reason: 'protocolUnsupported' };
  }
  if (options.publisher) {
    const published = await options.publisher.publish({
      filePath: options.path,
      fileName: options.asset.originalName,
      mediaType: options.asset.mediaType,
      sha256: options.asset.sha256,
      sizeBytes: options.asset.sizeBytes,
      modelId: options.modelId,
      signal: options.signal,
    });
    return {
      available: true,
      source: 'temporaryUrl',
      part: {
        fileData: {
          mimeType: options.asset.mediaType,
          fileUri: published.uri,
          displayName: options.asset.originalName,
        },
        partMetadata: { sugarcodeVideoFps: options.fps },
      },
    };
  }
  if (options.asset.sizeBytes > MAX_INLINE_VIDEO_BYTES) {
    return { available: false, reason: 'inlineLimitExceeded' };
  }
  const bytes = await (options.readLocalFile ?? readFile)(options.path);
  if (bytes.length !== options.asset.sizeBytes) {
    throw new Error('Stored video size changed before analysis.');
  }
  return {
    available: true,
    source: 'inline',
    part: {
      inlineData: {
        mimeType: options.asset.mediaType,
        data: bytes.toString('base64'),
        displayName: options.asset.originalName,
      },
      partMetadata: { sugarcodeVideoFps: options.fps },
    },
  };
};
