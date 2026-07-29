// @vitest-environment jsdom

import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentMarkdown } from '../agent-markdown';
import {
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
      '[aria-labelledby$="language-hint"]',
    );
    expect(codeFigure?.querySelector('figcaption')?.textContent).toContain(
      'Language hinttext',
    );
    expect(codeFigure?.getAttribute('aria-labelledby')).toBe(
      codeFigure?.querySelector('figcaption')?.id,
    );
    expect(codeFigure?.querySelector('button, a')).toBeNull();

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
    expect(captions).toHaveLength(1);
    expect(captions[0]?.textContent).toContain('Language hintRust');
    expect(document.querySelectorAll('pre code')).toHaveLength(3);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[class*="language-"]')).toBeNull();

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

  it('repairs only the live projection of incomplete Markdown', async () => {
    const source = [
      '## Live heading',
      '',
      'Use **durable truth',
      '',
      '```text',
      'partial code',
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
      'partial code',
    );
    expect(document.querySelector('figcaption')?.textContent).toContain(
      'Language hinttext',
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
