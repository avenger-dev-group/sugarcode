import { AtSign, BookOpenText, Box, File, LoaderCircle } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Textarea } from '@/renderer/components/ui/textarea';

import { ComposerHighlight } from './composer-highlight';
import type { ComposerInputProps, ComposerSuggestion } from './types';
import { useStore } from './use-store';

const SuggestionIcon = ({ suggestion }: Readonly<{ suggestion: ComposerSuggestion }>) => {
  if (suggestion.kind === 'skill') return <Box className="size-3.5" aria-hidden="true" />;
  if (suggestion.kind === 'knowledge') return <BookOpenText className="size-3.5" aria-hidden="true" />;
  if (suggestion.kind === 'file') return <File className="size-3.5" aria-hidden="true" />;
  return null;
};

export const ComposerInput = (props: ComposerInputProps) => {
  const store = useStore(props);
  const activeId = store.suggestions[store.activeIndex]
    ? `${store.listboxId}-${store.activeIndex}`
    : undefined;
  const triggerLabel =
    store.token?.trigger === '$'
      ? 'Skills'
      : store.token?.trigger === '@'
        ? '知识库与工作区文件'
        : '命令';

  return (
    <>
      {store.token ? (
        <section
          className="absolute inset-x-0 bottom-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border bg-background shadow-[0_18px_60px_var(--shadow-soft)]"
          aria-label={`${triggerLabel}建议`}
        >
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2 text-xs">
            <span className="flex min-w-0 items-center gap-2 font-medium text-secondary">
              {store.token.trigger === '$' ? (
                <Box className="size-3.5" aria-hidden="true" />
              ) : store.token.trigger === '@' ? (
                <AtSign className="size-3.5" aria-hidden="true" />
              ) : null}
              {triggerLabel}
              {store.token.query ? (
                <span className="truncate text-tertiary">· {store.token.query}</span>
              ) : null}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-tertiary">
              ↑↓ 选择 · Enter 插入 · Esc 关闭
            </span>
          </div>
          <div
            id={store.listboxId}
            role="listbox"
            aria-label={triggerLabel}
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {store.suggestions.map((suggestion, index) => (
              <Button
                key={suggestion.id}
                id={`${store.listboxId}-${index}`}
                type="button"
                variant="ghost"
                role="option"
                aria-selected={index === store.activeIndex}
                className={`h-10 w-full justify-start gap-2 rounded-lg px-2.5 text-left font-normal ${index === store.activeIndex ? 'bg-surface' : ''}`}
                onMouseEnter={() => store.setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => store.choose(suggestion)}
              >
                {suggestion.kind !== 'command' ? (
                  <span className="grid size-6 shrink-0 place-items-center text-secondary">
                    <SuggestionIcon suggestion={suggestion} />
                  </span>
                ) : null}
                <span className="max-w-44 shrink-0 truncate font-medium text-primary">
                  {suggestion.kind === 'skill' ? '$' : suggestion.kind === 'knowledge' ? '@' : ''}{suggestion.label}
                </span>
                {suggestion.alias ? (
                  <code className="shrink-0 font-mono text-[11px] text-tertiary">
                    {suggestion.alias}
                  </code>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-secondary">
                  {suggestion.description}
                </span>
                {suggestion.detail ? (
                  <span className="shrink-0 text-xs text-tertiary">{suggestion.detail}</span>
                ) : null}
              </Button>
            ))}
            {store.status === 'loading' ? (
              <div className="flex h-12 items-center gap-2 px-3 text-xs text-process">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                正在加载{triggerLabel}…
              </div>
            ) : null}
            {store.status !== 'loading' && store.suggestions.length === 0 ? (
              <p className={`px-3 py-4 text-xs ${store.status === 'error' ? 'text-destructive' : 'text-tertiary'}`}>
                {store.message ?? `没有匹配的${triggerLabel}。`}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
      <div className="relative">
        <div
          ref={store.mirrorRef}
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3 pb-2 text-sm font-normal leading-[22px] [scrollbar-gutter:stable] ${props.disabled ? 'opacity-50' : ''}`}
        >
          <ComposerHighlight value={props.value} activeToken={store.token} />
        </div>
        <Textarea
          ref={store.textareaRef}
          rows={1}
          value={props.value}
          onChange={store.handleChange}
          onPaste={props.onPaste}
          onKeyDown={store.handleKeyDown}
          onScroll={store.handleScroll}
          disabled={props.disabled}
          role="combobox"
          aria-haspopup="listbox"
          aria-label="Message SugarCode"
          aria-autocomplete="list"
          aria-controls={store.token ? store.listboxId : undefined}
          aria-expanded={Boolean(store.token)}
          aria-activedescendant={activeId}
          placeholder="描述任务，输入 / 使用命令、$ 使用 Skill、@ 引用知识库或文件…"
          autoFocus
          className="relative min-h-16 max-h-64 overflow-y-auto px-4 pt-3 pb-2 text-transparent caret-primary selection:bg-link/20 [field-sizing:content] [scrollbar-gutter:stable]"
        />
      </div>
    </>
  );
};
