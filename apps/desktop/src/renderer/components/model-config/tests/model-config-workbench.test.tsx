// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '@/shared/desktop-api';
import type { ModelConfigInspection } from '@/shared/model-config';

import { ModelConfigWorkbench } from '../model-config-workbench';

const INSPECTION: ModelConfigInspection = {
  contractVersion: 1,
  revision: 'a'.repeat(64),
  config: {
    apiFormat: 'openai-chat-completions',
    endpoint: 'http://127.0.0.1:18080/v1/chat/completions',
    model: 'fixture-model',
    credentialReference: 'model-api-token',
  },
  credentialStatus: 'present',
};

describe('ModelConfigWorkbench', () => {
  it('uses labelled fields, never reveals a credential, and clears password on submit', async () => {
    const save = vi.fn(async () => ({
      accepted: true as const,
      state: 'active' as const,
      inspection: INSPECTION,
    }));
    Object.defineProperty(window, 'sugarcode', {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => INSPECTION),
        saveModelConfig: save,
        deleteModelCredential: vi.fn(),
        retryModelConnection: vi.fn(),
      } as unknown as DesktopApi,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<ModelConfigWorkbench />));

    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Open model settings"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => Promise.resolve());

    const password = document.querySelector(
      '#model-credential',
    ) as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('new-password');
    expect(document.querySelector('label[for="model-endpoint"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('secret-sentinel');

    password.value = 'secret-sentinel';
    await act(async () => {
      (
        document.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(password.value).toBe('');
    expect(save).toHaveBeenCalledWith({
      expectedRevision: INSPECTION.revision,
      config: INSPECTION.config,
      credential: 'secret-sentinel',
    });
    expect(document.body.textContent).not.toContain('secret-sentinel');
    await act(async () => root.unmount());
  });
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

afterEach(() => document.body.replaceChildren());
