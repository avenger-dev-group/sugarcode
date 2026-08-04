import type {
  ThreadDescendantsListResponse,
  ThreadListResponse,
  ThreadSearchResponse,
} from '@sugarcode/app-server-protocol';

import {
  type ResumeSnapshot,
  isUuidV7,
  parseThreadResumeResponse,
} from './protocol';
import { isThreadTitle } from './thread-title';

const MAX_THREAD_RESULTS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const parseThreadCollection = (
  value: unknown,
  method: 'thread/list' | 'thread/search',
): ThreadListResponse => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > MAX_THREAD_RESULTS
  ) {
    throw new Error(`Invalid ${method} response.`);
  }
  const data = value.data.map((thread) => {
    if (
      !isRecord(thread) ||
      !isUuidV7(thread.id) ||
      !isId(thread.workspaceId) ||
      (Object.hasOwn(thread, 'title') && !isThreadTitle(thread.title))
    ) {
      throw new Error(`Invalid Thread in ${method} response.`);
    }
    return {
      id: thread.id,
      workspaceId: thread.workspaceId,
      ...(typeof thread.title === 'string' ? { title: thread.title } : {}),
    };
  });
  if (new Set(data.map((thread) => thread.id)).size !== data.length) {
    throw new Error(`Duplicate Thread in ${method} response.`);
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && !isUuidV7(nextCursor)) {
    throw new Error(`Invalid ${method} response.`);
  }
  return { data, nextCursor: nextCursor as string | null };
};

export const parseThreadListResponse = (
  value: unknown,
): ThreadListResponse => parseThreadCollection(value, 'thread/list');

export const parseThreadSearchResponse = (
  value: unknown,
): ThreadSearchResponse => parseThreadCollection(value, 'thread/search');

export const parseThreadForkResponse = (
  value: unknown,
): ResumeSnapshot => parseThreadResumeResponse(value);

export const parseThreadDescendantsListResponse = (
  value: unknown,
): readonly ResumeSnapshot[] => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > 12
  ) {
    throw new Error('Invalid thread/descendants/list response.');
  }
  const data = value.data.map(parseThreadResumeResponse);
  const response: ThreadDescendantsListResponse = {
    data: value.data as ThreadDescendantsListResponse['data'],
  };
  if (
    new Set(data.map((thread) => thread.threadId)).size !==
      response.data.length
  ) {
    throw new Error(
      'Duplicate Thread in thread/descendants/list response.',
    );
  }
  return data;
};

export const parseThreadEmptyResponse = (
  value: unknown,
  method:
    | 'thread/archive'
    | 'thread/unarchive'
    | 'thread/delete'
    | 'thread/title/generate',
): void => {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new Error(`Invalid ${method} response.`);
  }
};
