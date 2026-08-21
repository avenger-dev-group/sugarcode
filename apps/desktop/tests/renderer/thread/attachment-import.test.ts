import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectedVideoMediaType,
  importDraftAttachment,
  shouldInlineDraftAttachment,
} from '../../../src/renderer/components/thread/attachment-import.ts';
import { MAX_CONVERSATION_ATTACHMENT_BYTES } from '../../../src/shared/conversation.ts';

test('video media detection accepts MP4 MIME types and file extensions', () => {
  assert.equal(
    detectedVideoMediaType({ name: 'capture', type: 'video/mp4' }),
    'video/mp4',
  );
  assert.equal(
    detectedVideoMediaType({ name: 'capture.MP4', type: '' }),
    'video/mp4',
  );
});

test('videos within the Turn limit are imported immediately', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'capture.mp4', {
    type: 'video/mp4',
  });
  const attachment = await importDraftAttachment(file, () => {
    throw new Error('small videos must not depend on a temporary local path');
  });

  assert.equal('data' in attachment, true);
  assert.equal('data' in attachment ? attachment.data : undefined, 'AQID');
  assert.equal(attachment.mediaType, 'video/mp4');
});

test('only videos above the inline limit use path-based importing', () => {
  assert.equal(
    shouldInlineDraftAttachment({
      name: 'capture.mp4',
      type: 'video/mp4',
      size: MAX_CONVERSATION_ATTACHMENT_BYTES,
    }),
    true,
  );
  assert.equal(
    shouldInlineDraftAttachment({
      name: 'capture.mp4',
      type: 'video/mp4',
      size: MAX_CONVERSATION_ATTACHMENT_BYTES + 1,
    }),
    false,
  );
});
