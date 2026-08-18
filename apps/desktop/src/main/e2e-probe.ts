import { app, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';

type RendererProbeResult = Readonly<{
  checks: readonly string[];
  knowledgeBaseId: string;
}>;

const rendererProbe = async (): Promise<RendererProbeResult> => {
  const waitFor = async <T>(
    read: () => T | undefined | Promise<T | undefined>,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const check = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(`E2E assertion failed: ${label}`);
    checks.push(label);
  };
  const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim().includes(label));
  const setInput = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const openSearch = async (): Promise<HTMLInputElement> => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
    }));
    return waitFor(
      () => document.querySelector<HTMLInputElement>('input[role="combobox"]') ?? undefined,
      'global search combobox',
    );
  };
  const selectSearchResult = async (query: string, label: string): Promise<void> => {
    const input = await openSearch();
    setInput(input, query);
    const option = await waitFor(
      () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((candidate) => candidate.textContent?.includes(label)),
      `search result ${label}`,
    );
    option.click();
  };

  const checks: string[] = [];
  await waitFor(() => button('搜索或运行'), 'navigation search button');
  await waitFor(async () => {
    try {
      return await window.sugarcode.getKnowledge();
    } catch {
      return undefined;
    }
  }, 'private runtime readiness');
  const created = await window.sugarcode.createKnowledgeBase({
    name: 'E2E 精确导航知识库',
    description: '用于桌面端端到端检索验收',
    workspaceIds: [],
  });
  check(created.accepted && Boolean(created.knowledgeBaseId), 'knowledge IPC create');
  const knowledgeBaseId = created.accepted ? created.knowledgeBaseId ?? '' : '';
  const documentResult = await window.sugarcode.createKnowledgeTextDocument(knowledgeBaseId, {
    fileName: 'e2e-smoke.md',
    content: '# E2E\n\nUnique searchable desktop content.',
  });
  check(documentResult.accepted, 'knowledge text IPC and index');

  const opener = button('搜索或运行');
  opener?.focus();
  const accessibilityInput = await openSearch();
  setInput(accessibilityInput, '设置');
  await waitFor(
    () => document.querySelector<HTMLElement>('[role="option"]') ?? undefined,
    'search option',
  );
  check(accessibilityInput.getAttribute('aria-controls') === 'global-search-results', 'search combobox controls listbox');
  check(Boolean(document.querySelector('[role="listbox"]')), 'search listbox semantics');
  accessibilityInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  accessibilityInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  check(
    accessibilityInput.getAttribute('aria-activedescendant') === 'global-search-option-0',
    'search Home key restores first active option',
  );
  setInput(accessibilityInput, 'Unique searchable desktop content');
  await new Promise((resolve) => window.setTimeout(resolve, 100));
  check(
    ![...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .some((candidate) => candidate.textContent?.includes('E2E 精确导航知识库')),
    'global search excludes knowledge document bodies',
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  await waitFor(
    () => document.querySelector('input[role="combobox"]') ? undefined : true,
    'search close',
  );
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  check(document.activeElement === opener, 'search focus restoration');

  await selectSearchResult('E2E 精确导航', 'E2E 精确导航知识库');
  const knowledgeHeading = await waitFor(
    () => [...document.querySelectorAll('h1, h2')]
      .find((heading) => heading.textContent?.includes('E2E 精确导航知识库')) as HTMLElement | undefined,
    'exact knowledge detail navigation',
  );
  check(knowledgeHeading.textContent?.includes('E2E 精确导航知识库'), 'knowledge result opens exact detail');
  check(Boolean(document.querySelector('.window-no-drag')), 'main surface retains no-drag controls');

  await selectSearchResult('e2e-smoke-skill', 'e2e-smoke-skill');
  await waitFor(
    () => document.querySelector<HTMLElement>('#skill-detail-title') ?? undefined,
    'exact installed Skill detail navigation',
  );
  check(document.querySelector('#skill-detail-title')?.textContent?.includes('e2e-smoke-skill'), 'Skill detail matches search result');
  return { checks, knowledgeBaseId };
};

export const runDesktopE2EProbe = async (
  window: BrowserWindow,
  reportPath: string,
  startedAtMs: number,
): Promise<void> => {
  try {
    const renderer = await window.webContents.executeJavaScript(
      `(${rendererProbe.toString()})()`,
      true,
    ) as RendererProbeResult;
    const mainMemory = await process.getProcessMemoryInfo();
    const rendererPid = window.webContents.getOSProcessId();
    const rendererMetric = app.getAppMetrics().find(
      (metric) => metric.pid === rendererPid,
    );
    await writeFile(reportPath, JSON.stringify({
      ok: true,
      startupMs: Date.now() - startedAtMs,
      mainPrivateKb: mainMemory.private,
      rendererWorkingSetKb: rendererMetric?.memory?.workingSetSize ?? 0,
      checks: renderer.checks,
      knowledgeBaseId: renderer.knowledgeBaseId,
    }, null, 2));
  } catch (error) {
    await writeFile(reportPath, JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
  } finally {
    app.quit();
  }
};
