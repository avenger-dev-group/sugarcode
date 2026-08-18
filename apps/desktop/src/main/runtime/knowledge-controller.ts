import type { BrowserWindow, Dialog, OpenDialogOptions } from 'electron';
import { randomUUID } from 'node:crypto';

import type {
  KnowledgeActionResult,
  KnowledgeBaseDetail,
  KnowledgeCreateRequest,
  KnowledgeInspection,
  KnowledgeSearchResult,
} from '../../shared/knowledge.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

type KnowledgeControllerOptions = Readonly<{
  runtime: RuntimeSupervisor;
  dialog: Pick<Dialog, 'showOpenDialog'>;
  getMainWindow: () => BrowserWindow | null;
  getWorkspace: () => Readonly<{ workspaceId: string }> | null;
}>;

const knowledgeId = (value: unknown): value is string =>
  typeof value === 'string' && /^kb_[0-9a-f]{32}$/u.test(value);

const failed = (error: unknown): KnowledgeActionResult => ({
  accepted: false,
  reason:
    error instanceof Error && /UNIQUE|already exists/u.test(error.message)
      ? 'conflict'
      : 'unavailable',
  message: error instanceof Error ? error.message : '本地知识库暂时不可用。',
});

export class RuntimeKnowledgeController {
  constructor(private readonly options: KnowledgeControllerOptions) {}

  private workspaceId = (): string | undefined =>
    this.options.getWorkspace()?.workspaceId;

  inspect = async (): Promise<KnowledgeInspection> => {
    const event = await this.options.runtime.request(
      {
        type: 'knowledge.inspect',
        requestId: randomUUID(),
        workspaceId: this.workspaceId(),
      },
      'knowledge.inspection',
    );
    return event.inspection;
  };

  create = async (request: unknown): Promise<KnowledgeActionResult> => {
    if (!this.isCreateRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.create', requestId: randomUUID(), ...request },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  delete = async (id: unknown): Promise<KnowledgeActionResult> => {
    if (!knowledgeId(id)) return { accepted: false, reason: 'invalid' };
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.delete', requestId: randomUUID(), knowledgeBaseId: id },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  addFiles = async (id: unknown): Promise<KnowledgeActionResult> => {
    if (!knowledgeId(id)) return { accepted: false, reason: 'invalid' };
    const paths = await this.pick({
      title: '选择要复制到 SugarCode 的资料',
      buttonLabel: '添加并索引',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '可索引资料',
          extensions: [
            'txt', 'md', 'mdx', 'json', 'yaml', 'yml', 'xml', 'html', 'csv',
            'pdf', 'docx', 'rs', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'java',
            'swift', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'sh', 'sql',
            'toml', 'ini', 'css', 'scss', 'vue', 'svelte',
          ],
        },
      ],
    });
    if (!paths) return { accepted: false, reason: 'cancelled' };
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.addFiles', requestId: randomUUID(), knowledgeBaseId: id, paths },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  addFolder = async (id: unknown): Promise<KnowledgeActionResult> => {
    if (!knowledgeId(id)) return { accepted: false, reason: 'invalid' };
    const paths = await this.pick({
      title: '链接本地资料目录',
      buttonLabel: '链接并索引',
      properties: ['openDirectory'],
    });
    if (!paths) return { accepted: false, reason: 'cancelled' };
    try {
      const event = await this.options.runtime.request(
        {
          type: 'knowledge.addFolder',
          requestId: randomUUID(),
          knowledgeBaseId: id,
          path: paths[0],
        },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  detail = async (id: unknown): Promise<KnowledgeBaseDetail> => {
    if (!knowledgeId(id)) throw new Error('知识库标识无效。');
    const event = await this.options.runtime.request(
      { type: 'knowledge.detail', requestId: randomUUID(), knowledgeBaseId: id },
      'knowledge.detail',
    );
    return event.detail;
  };

  search = async (ids: unknown, query: unknown): Promise<KnowledgeSearchResult> => {
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 4 ||
      !ids.every(knowledgeId) ||
      typeof query !== 'string' ||
      query.trim().length === 0 ||
      query.length > 4_000
    ) {
      throw new Error('知识库检索请求无效。');
    }
    const event = await this.options.runtime.request(
      {
        type: 'knowledge.search',
        requestId: randomUUID(),
        workspaceId: this.workspaceId(),
        knowledgeBaseIds: ids,
        query,
      },
      'knowledge.searchResult',
    );
    return event.result;
  };

  installSemanticModel = async (): Promise<KnowledgeActionResult> => {
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.model.install', requestId: randomUUID() },
        'knowledge.action',
        60 * 60 * 1_000,
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  cancelSemanticModelDownload = async (): Promise<KnowledgeActionResult> => {
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.model.cancel', requestId: randomUUID() },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  removeSemanticModel = async (): Promise<KnowledgeActionResult> => {
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.model.remove', requestId: randomUUID() },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  private pick = async (options: OpenDialogOptions): Promise<string[] | null> => {
    const window = this.options.getMainWindow();
    if (!window) return null;
    const result = await this.options.dialog.showOpenDialog(window, options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
  };

  private isCreateRequest = (value: unknown): value is KnowledgeCreateRequest => {
    if (typeof value !== 'object' || value === null) return false;
    const request = value as Partial<KnowledgeCreateRequest>;
    return (
      typeof request.name === 'string' &&
      request.name.trim().length > 0 &&
      request.name.length <= 80 &&
      typeof request.description === 'string' &&
      request.description.length <= 1_024 &&
      Array.isArray(request.workspaceIds) &&
      request.workspaceIds.length <= 64 &&
      request.workspaceIds.every((id) => typeof id === 'string')
    );
  };
}
