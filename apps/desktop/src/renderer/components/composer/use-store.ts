import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { getSkills } from '@/renderer/services/skills';
import {
  listWorkspace,
  searchWorkspacePaths,
} from '@/renderer/services/workspace';
import type { SkillSummary } from '@/shared/skills';

import {
  commandSuggestions,
  findComposerToken,
  replaceComposerToken,
} from './suggestions';
import type {
  ComposerInputProps,
  ComposerSuggestion,
  ComposerSuggestionStatus,
  ComposerSuggestionStore,
  ComposerToken,
} from './types';

const skillSuggestion = (skill: SkillSummary): ComposerSuggestion => ({
  id: skill.id,
  kind: 'skill',
  label: skill.name,
  description: skill.description,
  detail: skill.source === 'project' ? '项目 Skill' : '个人 Skill',
  insertion: `$${skill.name}`,
});

const fileSuggestion = (path: string): ComposerSuggestion => ({
  id: `file:${path}`,
  kind: 'file',
  label: path.split('/').at(-1) ?? path,
  description: path,
  detail: '当前工作区',
  insertion: path.includes(' ') ? `@\`${path}\`` : `@${path}`,
});

export const useStore = (props: ComposerInputProps): ComposerSuggestionStore => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef<number>(0);
  const skillCache = useRef<readonly SkillSummary[] | null>(null);
  const [token, setToken] = useState<ComposerToken | null>(null);
  const [remoteSuggestions, setRemoteSuggestions] = useState<
    readonly ComposerSuggestion[]
  >([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [status, setStatus] = useState<ComposerSuggestionStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const rawId = useId();
  const listboxId = `composer-suggestions-${rawId.replace(/:/gu, '')}`;

  const suggestions = useMemo<readonly ComposerSuggestion[]>(() => {
    if (!token) {
      return [];
    }
    return token.trigger === '/'
      ? commandSuggestions(token.query)
      : remoteSuggestions;
  }, [remoteSuggestions, token]);

  useEffect(() => {
    if (!token || token.trigger === '/') {
      if (!token) skillCache.current = null;
      setRemoteSuggestions([]);
      setStatus(token ? 'ready' : 'idle');
      setMessage(null);
      return undefined;
    }

    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    setStatus('loading');
    setMessage(null);

    if (token.trigger === '$') {
      const load = skillCache.current
        ? Promise.resolve(skillCache.current)
        : getSkills().then((inspection) => {
            const enabled = inspection.skills.filter((skill) => skill.enabled);
            skillCache.current = enabled;
            return enabled;
          });
      void load
        .then((skills) => {
          if (requestId.current !== currentRequest) return;
          const query = token.query.toLocaleLowerCase();
          setRemoteSuggestions(
            skills
              .filter((skill) =>
                `${skill.name} ${skill.description}`
                  .toLocaleLowerCase()
                  .includes(query),
              )
              .map(skillSuggestion),
          );
          setStatus('ready');
          setMessage(skills.length === 0 ? '没有已启用的 Skill。' : null);
        })
        .catch(() => {
          if (requestId.current !== currentRequest) return;
          setRemoteSuggestions([]);
          setStatus('error');
          setMessage('暂时无法读取 Skills。');
        });
      return undefined;
    }

    if (!props.workspaceReady) {
      setRemoteSuggestions([]);
      setStatus('ready');
      setMessage('选择项目后可使用 @ 引用工作区文件。');
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const query = token.query.trim();
      const load = query
        ? searchWorkspacePaths({
            generation: props.workspaceGeneration,
            query,
          }).then((result) => {
            if (result.accepted === false) throw new Error(result.reason);
            return result.paths;
          })
        : listWorkspace({
            generation: props.workspaceGeneration,
            path: '',
          }).then((result) => {
            if (result.accepted === false) throw new Error(result.reason);
            return result.entries
              .filter((entry) => entry.kind === 'file')
              .map((entry) => entry.path);
          });
      void load
        .then((paths) => {
          if (requestId.current !== currentRequest) return;
          setRemoteSuggestions(paths.slice(0, 12).map(fileSuggestion));
          setStatus('ready');
          setMessage(paths.length === 0 ? '没有找到匹配的工作区文件。' : null);
        })
        .catch(() => {
          if (requestId.current !== currentRequest) return;
          setRemoteSuggestions([]);
          setStatus('error');
          setMessage('暂时无法搜索工作区文件。');
        });
    }, token.query ? 120 : 0);
    return () => window.clearTimeout(timer);
  }, [props.workspaceGeneration, props.workspaceReady, token]);

  useEffect(() => {
    if (!props.value) {
      setToken(null);
    }
  }, [props.value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [token?.query, token?.trigger]);

  const close = (): void => {
    requestId.current += 1;
    setToken(null);
    setRemoteSuggestions([]);
    setStatus('idle');
    setMessage(null);
  };

  const choose = (suggestion: ComposerSuggestion): void => {
    if (!token) return;
    const next = replaceComposerToken(props.value, token, suggestion.insertion);
    props.onValueChange(next.value);
    close();
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleChange: ComposerSuggestionStore['handleChange'] = (event) => {
    const value = event.currentTarget.value;
    props.onValueChange(value);
    setToken(
      props.disabled
        ? null
        : findComposerToken(value, event.currentTarget.selectionStart),
    );
  };

  const handleKeyDown: ComposerSuggestionStore['handleKeyDown'] = (event) => {
    if (token && event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (token && event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) =>
        suggestions.length > 0 ? (current + 1) % suggestions.length : 0,
      );
      return;
    }
    if (token && event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) =>
        suggestions.length > 0
          ? (current - 1 + suggestions.length) % suggestions.length
          : 0,
      );
      return;
    }
    if (
      token &&
      (event.key === 'Enter' || event.key === 'Tab') &&
      suggestions[activeIndex]
    ) {
      event.preventDefault();
      choose(suggestions[activeIndex]);
      return;
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      close();
      props.onSubmit();
    }
  };

  const handleScroll: ComposerSuggestionStore['handleScroll'] = (event) => {
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
      mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  };

  return {
    textareaRef,
    mirrorRef,
    token,
    suggestions,
    activeIndex,
    status,
    message,
    listboxId,
    handleChange,
    handleKeyDown,
    handleScroll,
    choose,
    setActiveIndex,
    close,
  };
};
