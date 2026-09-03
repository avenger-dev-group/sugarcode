import type { ModelConfigValue } from '../../shared/model-config.ts';
import {
  isRuntimeContentPart,
  type RuntimeAssetDescriptor,
  type RuntimeContentPart,
  type RuntimeThreadSnapshot,
} from '../contracts/protocol.ts';

const MAX_AVAILABLE_THREAD_IMAGES = 32;
const MAX_AVAILABLE_THREAD_VIDEOS = 16;

const usableImageProfile = (
  config: ModelConfigValue,
  profileId: string,
): boolean => {
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  const connection = config.connections.find(
    (candidate) => candidate.id === profile?.connectionId,
  );
  return Boolean(
    profile && connection?.enabled === true && profile.imageInput !== 'disabled',
  );
};

export const imageAnalysisProfileIds = (
  config: ModelConfigValue,
  currentProfileId: string,
): readonly string[] => {
  const preferred = [
    config.mediaRouting?.imageProfileId,
    currentProfileId,
    config.defaultProfileId,
  ];
  return preferred.filter(
    (profileId, index): profileId is string =>
      typeof profileId === 'string' &&
      preferred.indexOf(profileId) === index &&
      (profileId === currentProfileId || usableImageProfile(config, profileId)),
  );
};

const usableVideoProfile = (
  config: ModelConfigValue,
  profileId: string,
): boolean => {
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  const connection = config.connections.find(
    (candidate) => candidate.id === profile?.connectionId,
  );
  return Boolean(
    profile &&
    connection?.enabled === true &&
    profile.videoInput !== 'disabled',
  );
};

const usableAudioProfile = (
  config: ModelConfigValue,
  profileId: string,
): boolean => {
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  const connection = config.connections.find(
    (candidate) => candidate.id === profile?.connectionId,
  );
  return Boolean(
    profile &&
    connection?.enabled === true &&
    connection.wireApi !== 'anthropicMessages' &&
    profile.audioInput !== 'disabled',
  );
};

export const audioAnalysisProfileIds = (
  config: ModelConfigValue,
  videoProfileId: string | undefined,
  currentProfileId: string,
): readonly string[] => {
  const preferred = [
    config.mediaRouting?.audioProfileId,
    videoProfileId,
    currentProfileId,
    config.defaultProfileId,
  ];
  return preferred.filter(
    (profileId, index): profileId is string =>
      typeof profileId === 'string' &&
      preferred.indexOf(profileId) === index &&
      usableAudioProfile(config, profileId),
  );
};

export const videoAnalysisProfileIds = (
  config: ModelConfigValue,
  currentProfileId: string,
): readonly string[] => {
  const preferred = [
    config.mediaRouting?.videoProfileId,
    currentProfileId,
    config.defaultProfileId,
  ];
  return preferred.filter(
    (profileId, index): profileId is string =>
      typeof profileId === 'string' &&
      preferred.indexOf(profileId) === index &&
      usableVideoProfile(config, profileId),
  );
};

const imageAssets = (
  content: readonly RuntimeContentPart[],
): readonly RuntimeAssetDescriptor[] =>
  content.flatMap((part) =>
    part.type === 'asset' && part.asset.kind === 'image' ? [part.asset] : [],
  );

const videoAssets = (
  content: readonly RuntimeContentPart[],
): readonly RuntimeAssetDescriptor[] =>
  content.flatMap((part) =>
    part.type === 'asset' && part.asset.kind === 'video' ? [part.asset] : [],
  );

const storedUserContent = (
  snapshot: RuntimeThreadSnapshot,
): readonly (readonly RuntimeContentPart[])[] => {
  const contentByTurn = new Map<string, readonly RuntimeContentPart[]>();
  for (const item of snapshot.items) {
    const content = item.kind === 'turn.userMessage'
      ? item.payload.content
      : undefined;
    if (
      Array.isArray(content) &&
      content.every(isRuntimeContentPart)
    ) {
      contentByTurn.set(item.turnId, content);
    }
  }
  return [...snapshot.turns]
    .reverse()
    .flatMap((turn) => {
      const content = contentByTurn.get(turn.id);
      return content ? [content] : [];
    });
};

export const availableThreadImages = (
  snapshot: RuntimeThreadSnapshot,
  currentContent: readonly RuntimeContentPart[],
): readonly RuntimeAssetDescriptor[] => {
  const result: RuntimeAssetDescriptor[] = [];
  const seen = new Set<string>();
  for (const asset of [
    ...imageAssets(currentContent),
    ...storedUserContent(snapshot).flatMap(imageAssets),
  ]) {
    if (seen.has(asset.assetId)) {
      continue;
    }
    seen.add(asset.assetId);
    result.push(asset);
    if (result.length >= MAX_AVAILABLE_THREAD_IMAGES) {
      break;
    }
  }
  return result;
};

export const availableThreadVideos = (
  snapshot: RuntimeThreadSnapshot,
  currentContent: readonly RuntimeContentPart[],
): readonly RuntimeAssetDescriptor[] => {
  const result: RuntimeAssetDescriptor[] = [];
  const seen = new Set<string>();
  for (const asset of [
    ...videoAssets(currentContent),
    ...storedUserContent(snapshot).flatMap(videoAssets),
  ]) {
    if (seen.has(asset.assetId)) {
      continue;
    }
    seen.add(asset.assetId);
    result.push(asset);
    if (result.length >= MAX_AVAILABLE_THREAD_VIDEOS) {
      break;
    }
  }
  return result;
};
