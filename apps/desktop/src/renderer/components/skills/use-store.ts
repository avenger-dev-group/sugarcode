import { useCallback, useEffect, useRef, useState } from 'react';

import {
  exportSkill,
  getSkillContent,
  getSkills,
  importSkill,
  setSkillEnabled,
} from '@/renderer/services/skills';
import type {
  SkillContent,
  SkillScope,
  SkillSummary,
  SkillsInspection,
} from '@/shared/skills';

import type { SkillsStatus, SkillsStore } from './types';

export const useStore = (active: boolean): SkillsStore => {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [status, setStatus] = useState<SkillsStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean>(false);
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [content, setContent] = useState<SkillContent | null>(null);
  const [contentLoading, setContentLoading] = useState<boolean>(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<boolean>(false);
  const [importMenuOpen, setImportMenuOpen] = useState<boolean>(false);
  const contentRequest = useRef<number>(0);
  const detailRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const acceptInspection = useCallback((inspection: SkillsInspection): void => {
    setSkills(inspection.skills);
    setWorkspaceAvailable(inspection.workspaceAvailable);
    setStatus('ready');
    setSelectedSkill((current) =>
      current
        ? (inspection.skills.find((skill) => skill.id === current.id) ?? null)
        : null,
    );
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);
    setNotice(null);
    try {
      acceptInspection(await getSkills());
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : '无法加载 Skills。');
    }
  }, [acceptInspection]);

  useEffect(() => {
    if (active && status === 'idle') {
      void refresh();
    }
  }, [active, refresh, status]);

  const openSkill = useCallback(async (skill: SkillSummary): Promise<void> => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const request = contentRequest.current + 1;
    contentRequest.current = request;
    setSelectedSkill(skill);
    setContent(null);
    setContentError(null);
    setNotice(null);
    setContentLoading(true);
    try {
      const next = await getSkillContent(skill.id, skill.sha256);
      if (contentRequest.current === request) {
        setContent(next);
      }
    } catch (reason) {
      if (contentRequest.current === request) {
        setContentError(
          reason instanceof Error ? reason.message : '无法读取 SKILL.md。',
        );
      }
    } finally {
      if (contentRequest.current === request) {
        setContentLoading(false);
      }
    }
  }, []);

  const closeSkill = useCallback((): void => {
    contentRequest.current += 1;
    setSelectedSkill(null);
    setContent(null);
    setContentError(null);
    setContentLoading(false);
    setNotice(null);
    returnFocus.current?.focus();
  }, []);

  useEffect(() => {
    if (!selectedSkill) {
      return undefined;
    }
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSkill();
        return;
      }
      if (event.key !== 'Tab' || !detailRef.current) {
        return;
      }
      const focusable = Array.from(
        detailRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeSkill, selectedSkill]);

  useEffect(() => {
    if (!active && selectedSkill) {
      closeSkill();
    }
  }, [active, closeSkill, selectedSkill]);

  const toggle = useCallback(
    async (skill: SkillSummary): Promise<void> => {
      setActionPending(true);
      setError(null);
      setNotice(null);
      try {
        const result = await setSkillEnabled(skill.id, !skill.enabled);
        if (result.accepted === false || !result.inspection) {
          setError(
            result.accepted === false && result.message
              ? result.message
              : '无法更新 Skill 状态。',
          );
          return;
        }
        acceptInspection(result.inspection);
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : '无法更新 Skill 状态。',
        );
      } finally {
        setActionPending(false);
      }
    },
    [acceptInspection],
  );

  const importDirectory = useCallback(
    async (scope: SkillScope): Promise<void> => {
      setImportMenuOpen(false);
      setActionPending(true);
      setError(null);
      setNotice(null);
      try {
        const result = await importSkill(scope);
        if (result.accepted === false) {
          if (result.reason !== 'cancelled') {
            setError(result.message ?? '无法导入 Skill。');
          }
          return;
        }
        if (result.inspection) {
          acceptInspection(result.inspection);
        }
        setNotice(
          scope === 'project' ? '已导入到当前项目。' : '已导入到个人 Skills。',
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法导入 Skill。');
      } finally {
        setActionPending(false);
      }
    },
    [acceptInspection],
  );

  const exportDirectory = useCallback(
    async (skill: SkillSummary): Promise<void> => {
      setActionPending(true);
      setError(null);
      setNotice(null);
      try {
        const result = await exportSkill(skill.id);
        if (result.accepted === false) {
          if (result.reason !== 'cancelled') {
            setError(result.message ?? '无法导出 Skill。');
          }
          return;
        }
        setNotice(result.path ? `已导出到 ${result.path}` : 'Skill 已导出。');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法导出 Skill。');
      } finally {
        setActionPending(false);
      }
    },
    [],
  );

  return {
    skills,
    status,
    error,
    notice,
    workspaceAvailable,
    selectedSkill,
    content,
    contentLoading,
    contentError,
    actionPending,
    importMenuOpen,
    detailRef,
    closeButtonRef,
    setImportMenuOpen,
    refresh,
    toggle,
    openSkill,
    closeSkill,
    importDirectory,
    exportDirectory,
  };
};
