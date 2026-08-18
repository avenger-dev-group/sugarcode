import type { BrowserWindow, Dialog, OpenDialogOptions, Shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  KnowledgeActionResult,
  KnowledgeBaseDetail,
  KnowledgeCreateRequest,
  KnowledgeEditableDocument,
  KnowledgeInspection,
  KnowledgeSearchResult,
  KnowledgeTextCreateRequest,
  KnowledgeTextUpdateRequest,
  KnowledgeUpdateRequest,
} from '../../shared/knowledge.ts';
import type { RuntimeSupervisor } from './supervisor.ts';

type KnowledgeControllerOptions = Readonly<{
  runtime: RuntimeSupervisor;
  dialog: Pick<Dialog, 'showOpenDialog'>;
  getMainWindow: () => BrowserWindow | null;
  getWorkspace: () => Readonly<{ workspaceId: string }> | null;
  shell: Pick<Shell, 'openPath' | 'showItemInFolder'>;
}>;

const knowledgeId = (value: unknown): value is string =>
  typeof value === 'string' && /^kb_[0-9a-f]{32}$/u.test(value);
const sourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^ks_[0-9a-f]{32}$/u.test(value);
const indexJobId = (value: unknown): value is string =>
  typeof value === 'string' && /^kj_[0-9a-f]{32}$/u.test(value);
const documentId = (value: unknown): value is string =>
  typeof value === 'string' && /^kd_[0-9a-f]{32}$/u.test(value);

const failed = (error: unknown): KnowledgeActionResult => ({
  accepted: false,
  reason:
    error instanceof Error && /UNIQUE|already exists/u.test(error.message)
      ? 'conflict'
      : 'unavailable',
  message: error instanceof Error ? error.message : '本地知识库暂时不可用。',
});

export class RuntimeKnowledgeController {
  private readonly options: KnowledgeControllerOptions;

  constructor(options: KnowledgeControllerOptions) {
    this.options = options;
  }

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

  update = async (id: unknown, request: unknown): Promise<KnowledgeActionResult> => {
    if (!knowledgeId(id) || !this.isUpdateRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'knowledge.update',
          requestId: randomUUID(),
          knowledgeBaseId: id,
          ...request,
        },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  deleteSource = async (id: unknown): Promise<KnowledgeActionResult> => {
    if (!sourceId(id)) return { accepted: false, reason: 'invalid' };
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.source.delete', requestId: randomUUID(), sourceId: id },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  rescanSource = async (id: unknown, rebuild: unknown): Promise<KnowledgeActionResult> => {
    if (!sourceId(id) || (rebuild !== undefined && typeof rebuild !== 'boolean')) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'knowledge.source.rescan',
          requestId: randomUUID(),
          sourceId: id,
          rebuild: rebuild === true,
        },
        'knowledge.action',
        60 * 60 * 1_000,
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  cancelIndexJob = async (id: unknown): Promise<KnowledgeActionResult> => {
    if (!indexJobId(id)) return { accepted: false, reason: 'invalid' };
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.index.cancel', requestId: randomUUID(), jobId: id },
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

  createTextDocument = async (
    id: unknown,
    request: unknown,
  ): Promise<KnowledgeActionResult> => {
    if (!knowledgeId(id) || !this.isTextCreateRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'knowledge.text.create',
          requestId: randomUUID(),
          knowledgeBaseId: id,
          ...request,
        },
        'knowledge.action',
        60 * 60 * 1_000,
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  readTextDocument = async (id: unknown): Promise<KnowledgeEditableDocument> => {
    if (!sourceId(id)) throw new Error('知识文档标识无效。');
    const event = await this.options.runtime.request(
      { type: 'knowledge.text.read', requestId: randomUUID(), sourceId: id },
      'knowledge.textDocument',
    );
    return event.document;
  };

  updateTextDocument = async (
    id: unknown,
    request: unknown,
  ): Promise<KnowledgeActionResult> => {
    if (!sourceId(id) || !this.isTextUpdateRequest(request)) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        {
          type: 'knowledge.text.update',
          requestId: randomUUID(),
          sourceId: id,
          ...request,
        },
        'knowledge.action',
        60 * 60 * 1_000,
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

  openDocument = async (
    knowledgeBaseId: unknown,
    id: unknown,
  ): Promise<KnowledgeActionResult> => {
    try {
      const target = await this.resolveDocumentPath(knowledgeBaseId, id);
      const error = await this.options.shell.openPath(target);
      if (error) throw new Error(error);
      return { accepted: true };
    } catch (error) {
      return failed(error);
    }
  };

  revealDocument = async (
    knowledgeBaseId: unknown,
    id: unknown,
  ): Promise<KnowledgeActionResult> => {
    try {
      const target = await this.resolveDocumentPath(knowledgeBaseId, id);
      this.options.shell.showItemInFolder(target);
      return { accepted: true };
    } catch (error) {
      return failed(error);
    }
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

  selectRetrievalPlan = async (planId: unknown): Promise<KnowledgeActionResult> => {
    if (typeof planId !== 'string' || planId.length === 0 || planId.length > 128) {
      return { accepted: false, reason: 'invalid' };
    }
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.retrieval.select', requestId: randomUUID(), planId },
        'knowledge.action',
      );
      return event.action;
    } catch (error) {
      return failed(error);
    }
  };

  setSemanticIndexPaused = async (paused: unknown): Promise<KnowledgeActionResult> => {
    if (typeof paused !== 'boolean') return { accepted: false, reason: 'invalid' };
    try {
      const event = await this.options.runtime.request(
        { type: 'knowledge.semanticIndex.pause', requestId: randomUUID(), paused },
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

  private resolveDocumentPath = async (
    knowledgeBaseId: unknown,
    id: unknown,
  ): Promise<string> => {
    if (!knowledgeId(knowledgeBaseId) || !documentId(id)) {
      throw new Error('知识来源标识无效。');
    }
    const detail = await this.detail(knowledgeBaseId);
    const document = detail.documents.find((candidate) => candidate.id === id);
    if (!document) throw new Error('知识来源不存在或不在当前知识库。');
    const source = detail.sources.find((candidate) => candidate.id === document.sourceId);
    if (!source) throw new Error('知识来源已经不可用。');
    if (source.kind === 'managedFile') {
      return realpath(source.path);
    }
    const root = await realpath(source.path);
    const candidate = await realpath(path.resolve(root, document.relativePath));
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('知识来源路径越界。');
    }
    return candidate;
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

  private isUpdateRequest = (value: unknown): value is KnowledgeUpdateRequest => {
    if (!this.isCreateRequest(value)) return false;
    const request = value as Partial<KnowledgeUpdateRequest>;
    return (
      Array.isArray(request.ignoreRules) &&
      request.ignoreRules.length <= 256 &&
      request.ignoreRules.every(
        (rule) => typeof rule === 'string' && rule.length > 0 && rule.length <= 1_024,
      ) &&
      (request.semanticEnabled === undefined || typeof request.semanticEnabled === 'boolean')
    );
  };

  private isTextCreateRequest = (
    value: unknown,
  ): value is KnowledgeTextCreateRequest => {
    if (typeof value !== 'object' || value === null) return false;
    const request = value as Partial<KnowledgeTextCreateRequest>;
    return (
      typeof request.fileName === 'string' &&
      request.fileName.length > 0 &&
      request.fileName.length <= 255 &&
      !request.fileName.includes('/') &&
      !request.fileName.includes('\\') &&
      ![...request.fileName].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) &&
      /\.(?:txt|md)$/iu.test(request.fileName) &&
      typeof request.content === 'string' &&
      request.content.trim().length > 0 &&
      Buffer.byteLength(request.content, 'utf8') <= 2 * 1_024 * 1_024
    );
  };

  private isTextUpdateRequest = (
    value: unknown,
  ): value is KnowledgeTextUpdateRequest => {
    if (typeof value !== 'object' || value === null) return false;
    const request = value as Partial<KnowledgeTextUpdateRequest>;
    return (
      typeof request.expectedSha256 === 'string' &&
      /^[0-9a-f]{64}$/u.test(request.expectedSha256) &&
      typeof request.content === 'string' &&
      request.content.trim().length > 0 &&
      Buffer.byteLength(request.content, 'utf8') <= 2 * 1_024 * 1_024
    );
  };
}
