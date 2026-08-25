import { Fragment } from 'react';
import { AtSign, BookOpenText, Box, File, LoaderCircle, Shapes } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Textarea } from '@/renderer/components/ui/textarea';

import { ComposerHighlight } from './composer-highlight';
import type { ComposerInputProps, ComposerSuggestion } from './types';
import { useStore } from './use-store';

const FigmaMark = ({ compact = false }: Readonly<{ compact?: boolean }>) => (
  <svg
    viewBox="0 0 20 30"
    className={compact ? 'h-4 w-3' : 'h-5 w-3.5'}
    aria-hidden="true"
  >
    <path d="M0 5a5 5 0 0 1 5-5h5v10H5a5 5 0 0 1-5-5Z" fill="#f24e1e" />
    <path d="M10 0h5a5 5 0 0 1 0 10h-5V0Z" fill="#ff7262" />
    <path d="M0 15a5 5 0 0 1 5-5h5v10H5a5 5 0 0 1-5-5Z" fill="#a259ff" />
    <circle cx="15" cy="15" r="5" fill="#1abcfe" />
    <path d="M0 25a5 5 0 0 1 5-5h5v5a5 5 0 0 1-10 0Z" fill="#0acf83" />
  </svg>
);

const SuggestionIcon = ({ suggestion }: Readonly<{ suggestion: ComposerSuggestion }>) => {
  if (suggestion.brand === 'figma') return <FigmaMark compact={suggestion.kind !== 'application'} />;
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
      ? '能力'
      : store.token?.trigger === '@'
        ? '知识库与工作区文件'
        : '命令';

  return (
    <>
      {store.token ? (
        <section
          className="absolute inset-x-0 bottom-[calc(100%+8px)] z-30 overflow-hidden rounded-[18px] border bg-background/98 shadow-[0_20px_64px_var(--shadow-soft)] backdrop-blur-xl"
          aria-label={`${triggerLabel}建议`}
        >
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-xs">
            <span className="flex min-w-0 items-center gap-2 font-medium text-secondary">
              {store.token.trigger === '$' ? (
                <Shapes className="size-3.5" aria-hidden="true" />
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
            className="max-h-[22rem] overflow-y-auto px-2 pb-2"
          >
            {store.suggestions.map((suggestion, index) => {
              const previous = store.suggestions[index - 1];
              const startsApplicationGroup =
                store.token?.trigger === '$' &&
                suggestion.kind === 'application' &&
                previous?.kind !== 'application';
              const startsSkillGroup =
                store.token?.trigger === '$' &&
                suggestion.kind === 'skill' &&
                previous?.kind !== 'skill';
              const groupCount = store.suggestions.filter((candidate) =>
                startsApplicationGroup
                  ? candidate.kind === 'application'
                  : candidate.kind === 'skill',
              ).length;
              return (
                <Fragment key={suggestion.id}>
                  {startsApplicationGroup || startsSkillGroup ? (
                    <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1.5 text-[11px] font-medium tracking-wide text-tertiary">
                      <span>{startsApplicationGroup ? '应用' : '技能'}</span>
                      <span className="tabular-nums">{groupCount}</span>
                    </div>
                  ) : null}
                  <Button
                    id={`${store.listboxId}-${index}`}
                    type="button"
                    variant="ghost"
                    role="option"
                    aria-selected={index === store.activeIndex}
                    className={`${suggestion.kind === 'application' ? 'h-12' : 'h-10'} w-full justify-start gap-2.5 rounded-xl px-2.5 text-left font-normal transition-colors ${index === store.activeIndex ? 'bg-surface ring-1 ring-inset ring-border' : ''}`}
                    onMouseEnter={() => store.setActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => store.choose(suggestion)}
                  >
                    {suggestion.kind !== 'command' ? (
                      <span
                        className={`${suggestion.kind === 'application' ? 'size-8 rounded-[10px] border bg-white shadow-sm' : 'size-6'} grid shrink-0 place-items-center text-secondary`}
                      >
                        <SuggestionIcon suggestion={suggestion} />
                      </span>
                    ) : null}
                    <span className="max-w-52 shrink-0 truncate font-medium text-primary">
                      {suggestion.kind === 'skill' && !suggestion.alias
                        ? '$'
                        : suggestion.kind === 'knowledge'
                          ? '@'
                          : ''}
                      {suggestion.label}
                    </span>
                    {suggestion.alias ? (
                      <code className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] text-tertiary">
                        {suggestion.alias}
                      </code>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-secondary">
                      {suggestion.description}
                    </span>
                    {suggestion.detail ? (
                      <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-tertiary">
                        {suggestion.detail}
                      </span>
                    ) : null}
                  </Button>
                </Fragment>
              );
            })}
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
