// @vitest-environment jsdom

import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentMarkdown } from '../agent-markdown';
import {
  normalizeCompactMarkdownTables,
  projectAgentMarkdownTokens,
  repairStreamingMarkdown,
} from '../agent-markdown-parser';
import { AgentMessage } from '../agent-message';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const render = async (element: ReactNode): Promise<() => Promise<void>> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return async () => act(async () => root.unmount());
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('AgentMarkdown', () => {
  it('renders the bounded completed-message CommonMark surface', async () => {
    const unmount = await render(
      <AgentMarkdown
        source={[
          '## Durable heading',
          '',
          'Use **durable truth** with *care* and `inline_code`.',
          '',
          '- first item',
          '- second item',
          '',
          '> Recovered from rollout.',
          '',
          '```text',
          'exact fenced output',
          '```',
        ].join('\n')}
        isStreaming={false}
      />,
    );

    expect(document.querySelector('h2')?.textContent).toBe(
      'Durable heading',
    );
    expect(document.querySelector('strong')?.textContent).toBe(
      'durable truth',
    );
    expect(document.querySelector('em')?.textContent).toBe('care');
    expect(document.querySelectorAll('ul > li')).toHaveLength(2);
    expect(document.querySelector('blockquote')?.textContent).toContain(
      'Recovered from rollout.',
    );
    expect(document.querySelector('pre code')?.textContent).toContain(
      'exact fenced output',
    );
    const codeFigure = document.querySelector(
      '[aria-labelledby$="code-fence-caption"]',
    );
    expect(codeFigure?.querySelector('figcaption')?.textContent).toContain(
      'Language hinttext1 line',
    );
    expect(codeFigure?.getAttribute('aria-labelledby')).toBe(
      codeFigure?.querySelector('figcaption')?.id,
    );
    expect(
      codeFigure?.querySelector('figcaption')?.getAttribute('aria-label'),
    ).toBe('Language hint text, 1 line');
    expect(codeFigure?.querySelector('button, a')).toBeNull();
    expect(codeFigure?.querySelector('[aria-live]')).toBeNull();

    await unmount();
  });

  it('bounds and case-preserves fenced-code language hints', async () => {
    const unmount = await render(
      <AgentMarkdown
        source={[
          '```Rust title="durable"',
          'fn main() {}',
          '```',
          '',
          `\`\`\`${'x'.repeat(65)}`,
          'oversized hint remains code',
          '```',
          '',
          '```<script>',
          'invalid hint remains code',
          '```',
        ].join('\n')}
        isStreaming={false}
      />,
    );

    const captions = Array.from(document.querySelectorAll('figcaption'));
    expect(captions).toHaveLength(3);
    expect(captions[0]?.textContent).toContain('Language hintRust');
    expect(captions[0]?.textContent).toContain('1 line');
    expect(captions[1]?.textContent).toContain('Code fence');
    expect(captions[1]?.textContent).toContain('1 line');
    expect(captions[2]?.textContent).toContain('Code fence');
    expect(captions[2]?.textContent).toContain('1 line');
    expect(document.querySelectorAll('pre code')).toHaveLength(3);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[class*="language-"]')).toBeNull();

    await unmount();
  });

  it('counts only fenced-code content lines including intentional blanks', async () => {
    const unmount = await render(
      <AgentMarkdown
        source={[
          '```',
          '```',
          '',
          '```text',
          'one line',
          '```',
          '',
          '~~~Rust',
          'first line',
          'second line',
          '',
          '~~~',
          '',
          '    indented code',
        ].join('\n')}
        isStreaming={false}
      />,
    );

    const captions = Array.from(document.querySelectorAll('figcaption'));
    expect(captions.map((caption) => caption.textContent)).toEqual([
      'Code fence0 lines',
      'Language hinttext1 line',
      'Language hintRust3 lines',
    ]);
    expect(document.querySelectorAll('figure')).toHaveLength(3);
    expect(document.querySelectorAll('pre code')).toHaveLength(4);
    expect(
      captions.map((caption) => caption.getAttribute('aria-label')),
    ).toEqual([
      'Code fence, 0 lines',
      'Language hint text, 1 line',
      'Language hint Rust, 3 lines',
    ]);
    expect(
      Array.from(document.querySelectorAll('pre')).at(-1)?.closest('figure'),
    ).toBeNull();

    await unmount();
  });

  it('keeps HTML, links, and images inert', async () => {
    const unmount = await render(
      <AgentMarkdown
        source={[
          '<script>window.compromised = true</script>',
          '',
          '[External destination](https://example.com/path)',
          '',
          '![Remote preview](https://example.com/image.png)',
        ].join('\n')}
        isStreaming={false}
      />,
    );

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(
      document.querySelector('[role="link"]')?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(document.querySelector('[role="link"]')?.textContent).toBe(
      'External destination',
    );
    expect(document.querySelector('[role="img"]')?.textContent).toBe(
      'Image: Remote preview',
    );

    await unmount();
  });

  it('renders GFM tables with inline formatting and bounded overflow', async () => {
    const unmount = await render(
      <AgentMarkdown
        source={[
          '**Key concepts**',
          '',
          '| Concept | Description |',
          '|:--------|------------:|',
          '| **Dialplan** | `XML` routing |',
          '| Event Socket | [ESL](https://example.com/esl) control |',
        ].join('\n')}
        isStreaming={false}
      />,
    );

    const table = document.querySelector('table');
    expect(table).not.toBeNull();
    expect(document.querySelectorAll('thead th')).toHaveLength(2);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(document.querySelectorAll('tbody td')).toHaveLength(4);
    expect(document.querySelector('tbody strong')?.textContent).toBe(
      'Dialplan',
    );
    expect(document.querySelector('tbody code')?.textContent).toBe('XML');
    expect(document.querySelector('tbody a')).toBeNull();
    expect(document.querySelector('tbody [role="link"]')?.textContent).toBe(
      'ESL',
    );
    expect(
      table?.parentElement?.className,
    ).toContain('overflow-x-auto');
    expect(document.querySelectorAll('th[scope="col"]')).toHaveLength(2);
    expect(document.querySelector('th')?.className).toContain('text-left');
    expect(
      document.querySelectorAll('th')[1]?.className,
    ).toContain('text-right');

    await unmount();
  });

  it('repairs compact single-line table rows without changing fenced code', async () => {
    const compactTable =
      '| 概念 | 说明 | |------|------| | **Dialplan** | 呼叫路由逻辑，XML 或 inline 方式 | | ** Sofia SIP** | SIP 协议栈模块，管理 profile/gateway | | **Event Socket** | 外部程序通过 ESL 连接控制呼叫 | | **mod\\_模块* | 功能以模块形式加载，如 mod_dptools、mod_commands | | **Directory** | 用户注册目录，配置分机账号 |';
    const fenced = ['```text', compactTable, '```'].join('\n');
    const normalized = normalizeCompactMarkdownTables(compactTable);

    expect(normalized.length).toBe(compactTable.length);
    expect(normalized.split('\n')).toHaveLength(7);
    expect(normalizeCompactMarkdownTables(fenced)).toBe(fenced);

    const unmount = await render(
      <AgentMarkdown source={compactTable} isStreaming={false} />,
    );

    expect(document.querySelectorAll('thead th')).toHaveLength(2);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(
      Array.from(document.querySelectorAll('tbody strong')).map(
        (element) => element.textContent,
      ),
    ).toEqual([
      'Dialplan',
      'Sofia SIP',
      'Event Socket',
      'mod_模块',
      'Directory',
    ]);
    expect(document.body.textContent).toContain('profile/gateway');
    expect(document.body.textContent).not.toContain('------');
    expect(document.body.textContent).not.toContain('**');

    await unmount();
  });

  it('does not repair malformed emphasis inside fenced table text', async () => {
    const fenced = [
      '```text',
      '| A | B |',
      '|---|---|',
      '| ** spaced** | **unclosed* |',
      '```',
    ].join('\n');
    const unmount = await render(
      <AgentMarkdown source={fenced} isStreaming={false} />,
    );

    expect(document.querySelector('table')).toBeNull();
    expect(document.querySelector('pre code')?.textContent).toContain(
      '| ** spaced** | **unclosed* |',
    );

    await unmount();
  });

  it('keeps a growing compact table renderable while streaming', async () => {
    const unmount = await render(
      <AgentMarkdown
        source="| Name | State | |---|---| | parser | **streaming"
        isStreaming
      />,
    );

    expect(document.querySelectorAll('thead th')).toHaveLength(2);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(document.querySelector('tbody strong')?.textContent).toBe(
      'streaming',
    );

    await unmount();
  });

  it('repairs only the live projection of incomplete Markdown', async () => {
    const source = [
      '## Live heading',
      '',
      'Use **durable truth',
      '',
      '```text',
      'partial code',
      'second line',
    ].join('\n');
    const repaired = repairStreamingMarkdown(source);
    expect(source).not.toContain('```\n```');
    expect(repaired).toBe(`${source}\n\`\`\``);

    const unmount = await render(
      <AgentMessage
        message={{
          id: 'item_0000000000000002',
          text: source,
          state: 'streaming',
        }}
      />,
    );

    expect(document.querySelector('h2')?.textContent).toBe('Live heading');
    expect(document.querySelector('pre code')?.textContent).toBe(
      'partial code\nsecond line',
    );
    expect(document.querySelector('figcaption')?.textContent).toContain(
      'Language hinttext2 lines',
    );
    expect(document.body.textContent).not.toContain('```');
    expect(
      document.querySelectorAll('.agent-markdown-segment').length,
    ).toBeGreaterThan(0);

    await unmount();
  });

  it('reuses stable top-level token objects while only the tail grows', () => {
    const first = projectAgentMarkdownTokens(
      'Stable paragraph.\n\nMutable tail',
      true,
    );
    const second = projectAgentMarkdownTokens(
      'Stable paragraph.\n\nMutable tail grows.',
      true,
      first.cache,
    );

    expect(first.cache.prefixSource).toBe('Stable paragraph.\n\n');
    expect(second.tokens[0]).toBe(first.tokens[0]);
    expect(second.tokens.at(-1)?.raw).toContain('Mutable tail grows.');
  });

  it('bounds incremental token retention for exceptionally large text', () => {
    const projection = projectAgentMarkdownTokens(
      `${'x'.repeat(1_000_001)}\n\nTail`,
      true,
    );

    expect(projection.cache.prefixSource).toBe('');
    expect(projection.cache.prefixTokens).toHaveLength(0);
  });

  it('keeps an uncertain partial response as exact plain text', async () => {
    const unmount = await render(
      <AgentMessage
        message={{
          id: 'item_0000000000000001',
          text: 'Partial **Markdown is not complete**.',
          state: 'uncertain',
        }}
      />,
    );

    const response = document.querySelector(
      '[aria-label="Agent response status is unavailable"]',
    );
    expect(response?.textContent).toContain(
      'Partial **Markdown is not complete**.',
    );
    expect(response?.querySelector('strong')).toBeNull();
    expect(response?.querySelector('figcaption')).toBeNull();
    expect(response?.querySelector('pre')).toBeNull();

    await unmount();
  });
});
