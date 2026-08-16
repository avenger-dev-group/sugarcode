import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREVIEW_URL_MAX_BYTES } from '../../shared/preview.ts';

export type WebPreviewLocation = Readonly<{
  kind: 'web';
  url: string;
  origin: string;
}>;

export type ArtifactPreviewLocation = Readonly<{
  kind: 'artifact';
  url: string;
  origin: 'file://';
  root: string;
}>;

export type PreviewLocation = WebPreviewLocation | ArtifactPreviewLocation;

const hasForbiddenCodePoint = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const within = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative.length === 0 ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`));
};

export const parsePreviewLocation = (
  value: string,
): WebPreviewLocation | null => {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > PREVIEW_URL_MAX_BYTES ||
    value.includes('\\') ||
    hasForbiddenCodePoint(value)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }
  return {
    kind: 'web',
    url: parsed.toString(),
    origin: parsed.origin,
  };
};

export const createArtifactPreviewLocation = (
  url: string,
  root: string,
): ArtifactPreviewLocation => ({
  kind: 'artifact',
  url,
  origin: 'file://',
  root,
});

export const isLoopbackPreviewLocation = (
  location: WebPreviewLocation,
): boolean =>
  ['127.0.0.1', '[::1]', 'localhost'].includes(new URL(location.url).hostname);

const isAllowedArtifactFile = (
  location: ArtifactPreviewLocation,
  requested: URL,
): boolean => {
  if (requested.protocol !== 'file:') {
    return false;
  }
  try {
    const candidate = realpathSync(fileURLToPath(requested));
    return within(location.root, candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
};

export const isAllowedPreviewRequest = (
  location: PreviewLocation,
  url: string,
  method: string,
  resourceType: string,
): boolean => {
  if (
    Buffer.byteLength(url, 'utf8') > PREVIEW_URL_MAX_BYTES ||
    ['CONNECT', 'TRACE'].includes(method.toUpperCase()) ||
    resourceType === 'object' ||
    resourceType === 'cspReport'
  ) {
    return false;
  }
  let requested: URL;
  try {
    requested = new URL(url);
  } catch {
    return false;
  }
  const readOnly = ['GET', 'HEAD'].includes(method.toUpperCase());
  if (requested.protocol === 'data:' || requested.protocol === 'blob:') {
    return readOnly && resourceType !== 'mainFrame';
  }
  if (requested.protocol === 'file:') {
    return readOnly &&
      location.kind === 'artifact' &&
      isAllowedArtifactFile(location, requested);
  }
  if (resourceType === 'webSocket') {
    return ['ws:', 'wss:'].includes(requested.protocol);
  }
  return ['http:', 'https:'].includes(requested.protocol);
};
