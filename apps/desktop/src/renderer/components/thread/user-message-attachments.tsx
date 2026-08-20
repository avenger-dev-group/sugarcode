import { Image as ImageIcon, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/renderer/components/ui/dialog';
import { getConversationAttachmentPreview } from '@/renderer/services/conversation';
import type { ConversationAttachment } from '@/shared/conversation';

type ImageAttachmentProps = Readonly<{
  attachment: ConversationAttachment;
  threadId?: string;
}>;

const ImageAttachment = ({ attachment, threadId }: ImageAttachmentProps) => {
  const [previewUrl, setPreviewUrl] = useState(attachment.previewUrl ?? null);
  const [loading, setLoading] = useState(
    !attachment.previewUrl && Boolean(threadId),
  );

  useEffect(() => {
    if (previewUrl || !threadId) {
      return;
    }
    let active = true;
    setLoading(true);
    void getConversationAttachmentPreview({
      threadId,
      assetId: attachment.assetId,
    })
      .then((result) => {
        if (active && result.available) {
          setPreviewUrl(result.previewUrl);
        }
      })
      .catch((): undefined => undefined)
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [attachment.assetId, previewUrl, threadId]);

  if (!previewUrl) {
    return (
      <div
        className="flex size-[50px] items-center justify-center rounded-xl border bg-surface/70 text-secondary shadow-sm"
        role="img"
        aria-label={attachment.originalName}
      >
        {loading ? (
          <LoaderCircle
            className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="block size-[50px] cursor-zoom-in overflow-hidden rounded-xl border bg-surface shadow-sm outline-none transition-[border-color,box-shadow,transform] hover:border-foreground/25 hover:shadow-md active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label={`放大查看 ${attachment.originalName}`}
        >
          <img
            src={previewUrl}
            alt={attachment.originalName}
            className="block size-full object-cover"
          />
        </button>
      </DialogTrigger>
      <DialogContent className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[96rem] border-white/10 bg-black/95 p-0 text-white">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">
            {attachment.originalName}
          </DialogTitle>
          <DialogClose asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="-mr-2 size-10 rounded-full text-white/75 hover:bg-white/15 hover:text-white"
              aria-label="关闭图片预览"
              title="关闭"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
          <img
            src={previewUrl}
            alt={attachment.originalName}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const UserMessageAttachments = ({
  attachments,
  threadId,
}: Readonly<{
  attachments: readonly ConversationAttachment[];
  threadId?: string;
}>) => {
  const images = attachments.filter(
    (attachment) => attachment.kind === 'image',
  );
  const files = attachments.filter((attachment) => attachment.kind !== 'image');

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 grid justify-items-end gap-2" aria-label="消息附件">
      {images.length > 0 ? (
        <div className="flex max-w-full flex-wrap justify-end gap-2">
          {images.map((attachment) => (
            <ImageAttachment
              key={attachment.assetId}
              attachment={attachment}
              threadId={threadId}
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-2">
          {files.map((attachment) => (
            <span
              key={attachment.assetId}
              className="max-w-56 truncate rounded-xl border bg-surface px-3 py-2 text-xs font-medium text-secondary shadow-sm"
            >
              {attachment.originalName}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};
