import type { LlmRequest } from '@google/adk';
import type {
  Content,
  FunctionDeclaration,
  Part,
} from '@google/genai';

import type {
  NormalizedLlmRequest,
  NormalizedMessage,
  NormalizedMessagePart,
  NormalizedTool,
} from './types.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeProviderToolName = (
  name: string,
  occupied: Set<string>,
): string => {
  const base = name
    .replace(/[^A-Za-z0-9_-]/gu, '_')
    .replace(/^[^A-Za-z_]/u, '_$&')
    .slice(0, 112);
  let candidate = base || 'tool';
  let suffix = 1;
  while (occupied.has(candidate)) {
    candidate = `${base.slice(0, 104)}_${suffix}`;
    suffix += 1;
  }
  occupied.add(candidate);
  return candidate;
};

const textFromUnknownContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textFromUnknownContent).filter(Boolean).join('\n');
  }
  if (!isRecord(value)) {
    return '';
  }
  if (typeof value.text === 'string') {
    return value.text;
  }
  if (Array.isArray(value.parts)) {
    return value.parts
      .map(textFromUnknownContent)
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const normalizePart = (part: Part): NormalizedMessagePart | null => {
  if (typeof part.text === 'string') {
    return {
      type: 'text',
      text: part.text,
      thought: part.thought === true,
      ...(part.partMetadata ? { metadata: part.partMetadata } : {}),
    };
  }
  if (part.inlineData?.data && part.inlineData.mimeType) {
    return {
      type: 'media',
      mimeType: part.inlineData.mimeType,
      data: part.inlineData.data,
      ...(part.inlineData.displayName
        ? { name: part.inlineData.displayName }
        : {}),
    };
  }
  if (part.fileData?.fileUri && part.fileData.mimeType) {
    return {
      type: 'media',
      mimeType: part.fileData.mimeType,
      uri: part.fileData.fileUri,
      ...(part.fileData.displayName
        ? { name: part.fileData.displayName }
        : {}),
    };
  }
  if (part.functionCall?.name) {
    return {
      type: 'toolCall',
      id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
      name: part.functionCall.name,
      args: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse?.name) {
    return {
      type: 'toolResult',
      id: part.functionResponse.id ?? `call_${crypto.randomUUID()}`,
      name: part.functionResponse.name,
      result: part.functionResponse.response ?? {},
    };
  }
  return null;
};

const normalizeMessages = (
  contents: readonly Content[],
): readonly NormalizedMessage[] =>
  contents
    .map((content): NormalizedMessage | null => {
      const parts = (content.parts ?? [])
        .map(normalizePart)
        .filter((part): part is NormalizedMessagePart => part !== null);
      if (parts.length === 0) {
        return null;
      }
      return {
        role: content.role === 'model' ? 'assistant' : 'user',
        parts,
      };
    })
    .filter((message): message is NormalizedMessage => message !== null);

const toolList = (value: unknown): readonly unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const isFunctionDeclaration = (
  value: unknown,
): value is FunctionDeclaration =>
  isRecord(value) &&
  (value.name === undefined || typeof value.name === 'string') &&
  (value.description === undefined ||
    typeof value.description === 'string');

const functionDeclarations = (
  tools: unknown,
): readonly FunctionDeclaration[] =>
  toolList(tools).flatMap((tool) =>
    isRecord(tool) && Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations.filter(isFunctionDeclaration)
      : [],
  );

const normalizedParameters = (
  declaration: FunctionDeclaration,
): Readonly<Record<string, unknown>> => {
  if (isRecord(declaration.parametersJsonSchema)) {
    return declaration.parametersJsonSchema;
  }
  if (isRecord(declaration.parameters)) {
    return declaration.parameters;
  }
  return { type: 'object', properties: {}, additionalProperties: false };
};

const normalizeTools = (
  request: LlmRequest,
): readonly NormalizedTool[] => {
  const occupied = new Set<string>();
  return functionDeclarations(request.config?.tools).flatMap(
    (declaration): readonly NormalizedTool[] => {
      const adkName = declaration.name;
      if (!adkName) {
        return [];
      }
      return [
        {
          adkName,
          providerName: normalizeProviderToolName(adkName, occupied),
          description: declaration.description ?? '',
          parameters: normalizedParameters(declaration),
        },
      ];
    },
  );
};

export const normalizeLlmRequest = (
  request: LlmRequest,
  fallbackModel: string,
): NormalizedLlmRequest => {
  const tools = normalizeTools(request);
  return {
    model: request.model ?? fallbackModel,
    system: textFromUnknownContent(request.config?.systemInstruction),
    messages: normalizeMessages(request.contents),
    tools,
    toolNameByProviderName: new Map(
      tools.map((tool) => [tool.providerName, tool.adkName]),
    ),
    ...(request.config ? { config: request.config } : {}),
  };
};
