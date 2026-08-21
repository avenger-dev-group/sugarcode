import {
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  type ConversationAttachmentFailure,
} from '../../../shared/conversation.ts';

import type { DraftAttachmentViewModel } from './types';

const VIDEO_MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  webm: 'video/webm',
};

export const detectedVideoMediaType = (
  file: Pick<File, 'name' | 'type'>,
): string | undefined => {
  if (file.type.startsWith('video/')) {
    return file.type;
  }
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return VIDEO_MEDIA_TYPES_BY_EXTENSION[extension ?? ''];
};

export const shouldInlineDraftAttachment = (
  file: Pick<File, 'name' | 'type' | 'size'>,
): boolean =>
  !detectedVideoMediaType(file) ||
  file.size <= MAX_CONVERSATION_ATTACHMENT_BYTES;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export const importDraftAttachment = async (
  file: File,
  getLocalFilePath: (file: File) => string,
): Promise<DraftAttachmentViewModel> => {
  const videoMediaType = detectedVideoMediaType(file);
  if (videoMediaType && !shouldInlineDraftAttachment(file)) {
    return {
      id: crypto.randomUUID(),
      fileName: file.name,
      mediaType: videoMediaType,
      sizeBytes: file.size,
      localPath: getLocalFilePath(file),
    };
  }

  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    mediaType: videoMediaType ?? file.type,
    sizeBytes: file.size,
    data,
    ...(file.type.startsWith('image/')
      ? { previewUrl: `data:${file.type};base64,${data}` }
      : {}),
  };
};

const ATTACHMENT_IMPORT_FAILURE_MESSAGES: Readonly<
  Record<ConversationAttachmentFailure, string>
> = {
  sourceUnavailable: '附件源文件已失效，请重新添加后发送。',
  unsupportedFormat: '附件格式不受支持或文件已损坏，请检查后重试。',
  mediaTypeMismatch: '附件扩展名或类型与实际内容不一致，请确认文件来源。',
  tooLarge: '附件超过允许的大小限制。',
  runtimeOutdated: '当前原生组件版本不支持大视频导入，请重启并更新 SugarCode。',
  storageUnavailable: '本地附件存储暂时不可用，请重启 SugarCode 后重试。',
  unknown: '附件导入失败，请重新添加后重试。',
};

export const attachmentImportFailureMessage = (
  failure: ConversationAttachmentFailure | undefined,
): string => ATTACHMENT_IMPORT_FAILURE_MESSAGES[failure ?? 'unknown'];
