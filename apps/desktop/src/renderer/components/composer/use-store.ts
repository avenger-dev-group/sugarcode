import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getSkills } from '@/renderer/services/skills';
import { getKnowledge } from '@/renderer/services/knowledge';
import {
  listWorkspace,
  searchWorkspacePaths,
} from '@/renderer/services/workspace';
import type { SkillSummary } from '@/shared/skills';
import type { KnowledgeBaseSummary } from '@/shared/knowledge';

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

const knowledgeSuggestion = (
  knowledgeBase: KnowledgeBaseSummary,
): ComposerSuggestion => ({
  id: knowledgeBase.id,
  kind: 'knowledge',
  label: knowledgeBase.name,
  description: knowledgeBase.description || `${knowledgeBase.documentCount} 个文档`,
  detail: knowledgeBase.scope === 'global' ? '全局知识库' : '当前项目知识库',
  insertion: /\s/u.test(knowledgeBase.name)
    ? `@知识库\`${knowledgeBase.name}\``
    : `@知识库${knowledgeBase.name}`,
});

const syncMirrorLayout = (
  textarea: HTMLTextAreaElement,
  mirror: HTMLDivElement,
): void => {
  // Classic scrollbars reduce a textarea's client width. Keep the visible
  // mirror on that same width so both layers wrap text at identical points.
  mirror.style.right = `${Math.max(0, textarea.offsetWidth - textarea.clientWidth)}px`;
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
};

export const useStore = (props: ComposerInputProps): ComposerSuggestionStore => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const requestId = useRef<number>(0);
  const skillCache = useRef<readonly SkillSummary[] | null>(null);
  const knowledgeCache = useRef<readonly KnowledgeBaseSummary[] | null>(null);
  const [token, setToken] = useState<ComposerToken | null>(null);
  const [remoteSuggestions, setRemoteSuggestions] = useState<
    readonly ComposerSuggestion[]
  >([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [status, setStatus] = useState<ComposerSuggestionStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const rawId = useId();
  const listboxId = `composer-suggestions-${rawId.replace(/:/gu, '')}`;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (textarea && mirror) {
      syncMirrorLayout(textarea, mirror);
    }
  }, [props.value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) {
      return undefined;
    }
    const observer = new ResizeObserver(() => syncMirrorLayout(textarea, mirror));
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

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
      requestId.current += 1;
      if (!token) {
        skillCache.current = null;
        knowledgeCache.current = null;
      }
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

    const timer = window.setTimeout(() => {
      const query = token.query.trim();
      const knowledgeLoad = knowledgeCache.current
        ? Promise.resolve(knowledgeCache.current)
        : getKnowledge().then((inspection) => {
            knowledgeCache.current = inspection.knowledgeBases;
            return inspection.knowledgeBases;
          });
      const fileLoad = !props.workspaceReady
        ? Promise.resolve([] as readonly string[])
        : query
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
      void Promise.all([knowledgeLoad, fileLoad])
        .then(([knowledgeBases, paths]) => {
          if (requestId.current !== currentRequest) return;
          const normalized = query.toLocaleLowerCase();
          const knowledge = knowledgeBases
            .filter((base) =>
              `${base.name} ${base.description}`
                .toLocaleLowerCase()
                .includes(normalized),
            )
            .slice(0, 6)
            .map(knowledgeSuggestion);
          setRemoteSuggestions([
            ...knowledge,
            ...paths.slice(0, Math.max(0, 12 - knowledge.length)).map(fileSuggestion),
          ]);
          setStatus('ready');
          setMessage(
            knowledge.length === 0 && paths.length === 0
              ? props.workspaceReady
                ? '没有找到匹配的知识库或工作区文件。'
                : '没有找到匹配的全局知识库。'
              : null,
          );
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
    const hasSuggestionTrigger =
      value.includes('/') || value.includes('$') || value.includes('@');
    setToken(
      props.disabled || !hasSuggestionTrigger
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
      syncMirrorLayout(event.currentTarget, mirrorRef.current);
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
