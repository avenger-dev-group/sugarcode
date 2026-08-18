import {
  ChevronDown,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { MessageCopyButton } from '@/renderer/components/message-actions/message-copy-button';
import { Button } from '@/renderer/components/ui/button';

import { hasCopyableUserText } from './message-edit';
import type {
  ThreadWorkbenchViewProps,
  TranscriptMessageViewModel,
} from './types';

const COLLAPSED_USER_MESSAGE_HEIGHT = 220;
const MAX_MESSAGE_EDITOR_HEIGHT = 320;

type UserMessageView = Extract<
  TranscriptMessageViewModel,
  { role: 'user' }
>['message'];

const MessageAttachments = ({ message }: Readonly<{ message: UserMessageView }>) =>
  message.attachments.length > 0 ? (
    <div className="mb-2 flex flex-wrap gap-2">
      {message.attachments.map((attachment) => (
        <div
          key={attachment.assetId}
          className="flex max-w-56 items-center gap-2 rounded-xl bg-background/70 px-2.5 py-2"
        >
          {attachment.kind === 'image' && attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt=""
              className="size-8 shrink-0 rounded-md object-cover"
            />
          ) : attachment.kind === 'image' ? (
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <FileText className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate text-xs font-medium">
            {attachment.originalName}
          </span>
        </div>
      ))}
    </div>
  ) : null;

const MessageReferences = ({ message }: Readonly<{ message: UserMessageView }>) =>
  message.references.length > 0 ? (
    <div
      className="flex flex-wrap justify-end gap-1.5"
      aria-label="已选择的能力和引用"
    >
      {message.references.map((reference) => (
        <span
          key={`${reference.kind}:${reference.target}`}
          className="inline-flex max-w-64 items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs text-link shadow-sm"
          title={reference.target}
        >
          <span className="text-tertiary">
            {reference.kind === 'command'
              ? '命令'
              : reference.kind === 'skill'
                ? 'Skill'
                : reference.kind === 'knowledge'
                  ? '知识库'
                : '文件'}
          </span>
          <span className="truncate font-medium">{reference.value}</span>
        </span>
      ))}
    </div>
  ) : null;

const UserMessageContent = ({
  message,
}: Readonly<{
  message: UserMessageView;
}>) => {
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }

    const measureOverflow = () => {
      setCanCollapse(
        content.scrollHeight > COLLAPSED_USER_MESSAGE_HEIGHT + 1,
      );
    };

    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [message.attachments.length, message.text]);

  return (
    <>
      <div className="relative">
        <div
          ref={contentRef}
          id={contentId}
          className={expanded ? undefined : 'overflow-hidden'}
          style={
            expanded ? undefined : { maxHeight: COLLAPSED_USER_MESSAGE_HEIGHT }
          }
        >
          <MessageAttachments message={message} />
          {message.text ? (
            <p className="whitespace-pre-wrap break-words text-sm font-normal leading-[22px]">
              {message.text}
            </p>
          ) : null}
        </div>
        {canCollapse && !expanded ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-b from-transparent to-user-message"
            aria-hidden="true"
          />
        ) : null}
      </div>
      {canCollapse ? (
        <button
          type="button"
          className="mt-1.5 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-current/70 transition-colors hover:bg-background/25 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
          {expanded ? '收起' : '展开'}
        </button>
      ) : null}
    </>
  );
};

const UserMessageEditor = ({
  message,
  draft,
  pending,
  error,
  onChange,
  onCancel,
  onSubmit,
}: Readonly<{
  message: UserMessageView;
  draft: string;
  pending: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => Promise<void>;
}>) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(
      textarea.scrollHeight,
      MAX_MESSAGE_EDITOR_HEIGHT,
    )}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_MESSAGE_EDITOR_HEIGHT ? 'auto' : 'hidden';
  };

  useLayoutEffect(resize, [draft]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const canSubmit =
    !pending &&
    (draft.trim().length > 0 || message.attachments.length > 0);

  return (
    <article
      className="w-full rounded-2xl border border-border bg-surface px-4 py-3 shadow-sm"
      aria-label="编辑你的消息"
    >
      <MessageAttachments message={message} />
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={pending}
        rows={3}
        className="block min-h-20 w-full resize-none bg-transparent text-sm font-normal leading-[22px] text-foreground outline-none placeholder:text-tertiary disabled:opacity-70"
        aria-label="编辑消息内容"
        aria-invalid={Boolean(error)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            if (canSubmit) {
              void onSubmit();
            }
          }
        }}
      />
      {message.references.length > 0 ? (
        <div className="mt-3">
          <MessageReferences message={message} />
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p
          className="min-w-0 text-xs text-destructive"
          role={error ? 'alert' : undefined}
        >
          {error ?? ''}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={() => void onSubmit()}
          >
            {pending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : null}
            发送
          </Button>
        </div>
      </div>
    </article>
  );
};

type UserMessageProps = Readonly<{
  entry: Extract<TranscriptMessageViewModel, { role: 'user' }>;
  turnId?: string;
  editable?: boolean;
  editor?: ThreadWorkbenchViewProps['store']['messageEditor'];
  onBeginEdit?: ThreadWorkbenchViewProps['store']['beginMessageEdit'];
  onSetEditDraft?: ThreadWorkbenchViewProps['store']['setMessageEditDraft'];
  onCancelEdit?: ThreadWorkbenchViewProps['store']['cancelMessageEdit'];
  onSubmitEdit?: ThreadWorkbenchViewProps['store']['submitMessageEdit'];
}>;

export const UserMessage = ({
  entry,
  turnId,
  editable = false,
  editor,
  onBeginEdit,
  onSetEditDraft,
  onCancelEdit,
  onSubmitEdit,
}: UserMessageProps) => {
  const editing = editor?.turnId !== null && editor?.turnId !== undefined;

  return (
    <div
      className={`ml-auto min-w-0 max-w-[82%] ${editing ? 'w-full' : 'w-fit'}`}
    >
      {editing && editor && onSetEditDraft && onCancelEdit && onSubmitEdit ? (
        <UserMessageEditor
          message={entry.message}
          draft={editor.draft}
          pending={editor.pending}
          error={editor.error}
          onChange={onSetEditDraft}
          onCancel={onCancelEdit}
          onSubmit={onSubmitEdit}
        />
      ) : (
        <>
          {entry.message.text || entry.message.attachments.length > 0 ? (
            <article
              className="rounded-2xl rounded-br-md bg-user-message px-4 py-3 text-user-message-foreground"
              aria-label="Your message"
            >
              <UserMessageContent message={entry.message} />
            </article>
          ) : null}
          {entry.message.references.length > 0 ? (
            <div className="mt-2 px-1">
              <MessageReferences message={entry.message} />
            </div>
          ) : null}
          <div className="flex h-7 items-center justify-end gap-0.5">
            {hasCopyableUserText(entry.message.text) ? (
              <MessageCopyButton
                text={entry.message.text}
                className="text-tertiary hover:text-foreground"
              />
            ) : null}
            {editable && turnId && onBeginEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-tertiary hover:text-foreground"
                aria-label="编辑并重新发送消息"
                title="编辑并重新发送"
                onClick={() =>
                  onBeginEdit(turnId, entry.message.id, entry.message.text)
                }
              >
                <Pencil aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
};
