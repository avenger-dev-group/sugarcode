export const isApprovalVisibleForThread = (
  requestThreadId: string | undefined,
  activeThreadId: string | null,
): boolean =>
  requestThreadId !== undefined && requestThreadId === activeThreadId;
