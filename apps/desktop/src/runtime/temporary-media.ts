import { openAsBlob } from 'node:fs';
import path from 'node:path';

import type { ModelMediaTransport } from '../shared/model-config.ts';

export type PublishedMedia = Readonly<{
  uri: string;
}>;

export type TemporaryMediaPublisher = Readonly<{
  publish: (input: Readonly<{
    filePath: string;
    fileName: string;
    mediaType: string;
    sha256: string;
    sizeBytes: number;
    modelId: string;
    signal: AbortSignal;
  }>) => Promise<PublishedMedia>;
}>;

type DashscopeUploadPolicy = Readonly<{
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  max_file_size_mb: string | number;
  oss_access_key_id: string;
  x_oss_object_acl: string;
  x_oss_forbid_overwrite: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dashscopeUploadOrigin = (baseUrl: string): string => {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname.includes('ap-southeast-1') || hostname.includes('intl')
    ? 'https://dashscope-intl.aliyuncs.com'
    : 'https://dashscope.aliyuncs.com';
};

const looksLikeDashscopeEndpoint = (baseUrl: string): boolean => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === 'dashscope.aliyuncs.com' ||
      hostname === 'dashscope-intl.aliyuncs.com' ||
      hostname.endsWith('.maas.aliyuncs.com')
    );
  } catch {
    return false;
  }
};

export const effectiveMediaTransport = (
  configured: ModelMediaTransport | undefined,
  baseUrl: string,
): Exclude<ModelMediaTransport, 'auto'> => {
  const transport = configured ?? 'auto';
  if (transport !== 'auto') {
    return transport;
  }
  return looksLikeDashscopeEndpoint(baseUrl)
    ? 'dashscopeTemporaryUrl'
    : 'inline';
};

const uploadPolicy = (value: unknown): DashscopeUploadPolicy => {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new Error('The media upload service returned an invalid policy.');
  }
  const data = value.data;
  const required = [
    'policy',
    'signature',
    'upload_dir',
    'upload_host',
    'max_file_size_mb',
    'oss_access_key_id',
    'x_oss_object_acl',
    'x_oss_forbid_overwrite',
  ] as const;
  if (
    required.some((key) =>
      key === 'max_file_size_mb'
        ? !['string', 'number'].includes(typeof data[key])
        : typeof data[key] !== 'string',
    )
  ) {
    throw new Error('The media upload policy is incomplete.');
  }
  return data as DashscopeUploadPolicy;
};

const boundedResponseText = async (response: Response): Promise<string> =>
  (await response.text()).slice(0, 512);

export const createDashscopeTemporaryMediaPublisher = (options: Readonly<{
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}>): TemporaryMediaPublisher => {
  const request = options.fetch ?? globalThis.fetch;
  const uploadOrigin = dashscopeUploadOrigin(options.baseUrl);
  return {
    publish: async (input): Promise<PublishedMedia> => {
      const policyUrl = new URL('/api/v1/uploads', uploadOrigin);
      policyUrl.searchParams.set('action', 'getPolicy');
      policyUrl.searchParams.set('model', input.modelId);
      const policyResponse = await request(policyUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: input.signal,
      });
      if (!policyResponse.ok) {
        throw new Error(
          `Media upload policy request failed (${policyResponse.status}): ${await boundedResponseText(policyResponse)}`,
        );
      }
      const policy = uploadPolicy(await policyResponse.json());
      const maxBytes = Number(policy.max_file_size_mb) * 1024 * 1024;
      if (!Number.isFinite(maxBytes) || input.sizeBytes > maxBytes) {
        throw new Error('The video exceeds the temporary upload limit for this model.');
      }
      const safeName = path.basename(input.fileName).replace(/[\p{Cc}]/gu, '_');
      const key = `${policy.upload_dir}/${input.sha256.slice(0, 16)}-${safeName}`;
      const form = new FormData();
      form.append('OSSAccessKeyId', policy.oss_access_key_id);
      form.append('Signature', policy.signature);
      form.append('policy', policy.policy);
      form.append('x-oss-object-acl', policy.x_oss_object_acl);
      form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
      form.append('key', key);
      form.append('success_action_status', '200');
      form.append(
        'file',
        await openAsBlob(input.filePath, { type: input.mediaType }),
        safeName,
      );
      const uploadResponse = await request(policy.upload_host, {
        method: 'POST',
        body: form,
        signal: input.signal,
      });
      if (!uploadResponse.ok) {
        throw new Error(
          `Temporary media upload failed (${uploadResponse.status}): ${await boundedResponseText(uploadResponse)}`,
        );
      }
      return {
        uri: `oss://${key}`,
      };
    },
  };
};
