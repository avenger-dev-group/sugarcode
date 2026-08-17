export type DrawioSessionState = {
  autoOpenedPaths: Set<string>;
  dismissedPaths: Set<string>;
  selectedPath: string | null;
};

export type DrawioSessionRegistry = Map<string, DrawioSessionState>;

const MAX_REMEMBERED_SCOPES = 100;
const FALLBACK_SCOPE_KEY = '__no_active_thread__';

const registryScopeKey = (scopeKey: string | null): string =>
  scopeKey ?? FALLBACK_SCOPE_KEY;

const getSession = (
  registry: DrawioSessionRegistry,
  scopeKey: string | null,
  create: boolean,
): DrawioSessionState | undefined => {
  const key = registryScopeKey(scopeKey);
  const existing = registry.get(key);
  if (existing || !create) return existing;
  const session: DrawioSessionState = {
    autoOpenedPaths: new Set(),
    dismissedPaths: new Set(),
    selectedPath: null,
  };
  registry.set(key, session);
  while (registry.size > MAX_REMEMBERED_SCOPES) {
    const oldest = registry.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
  return session;
};

export const getSelectedDrawioPath = (
  registry: DrawioSessionRegistry,
  scopeKey: string | null,
): string | null => getSession(registry, scopeKey, false)?.selectedPath ?? null;

export const openDrawioForSession = (
  registry: DrawioSessionRegistry,
  scopeKey: string | null,
  path: string,
  automatic: boolean,
): boolean => {
  const session = getSession(registry, scopeKey, true);
  if (!session) return false;
  if (
    automatic &&
    (session.dismissedPaths.has(path) || session.autoOpenedPaths.has(path))
  ) {
    return false;
  }
  session.dismissedPaths.delete(path);
  session.autoOpenedPaths.add(path);
  session.selectedPath = path;
  return true;
};

export const closeDrawioForSession = (
  registry: DrawioSessionRegistry,
  scopeKey: string | null,
  path: string,
): void => {
  const session = getSession(registry, scopeKey, true);
  session?.dismissedPaths.add(path);
  if (session?.selectedPath === path) session.selectedPath = null;
};

export const clearSelectedDrawioForSession = (
  registry: DrawioSessionRegistry,
  scopeKey: string | null,
): void => {
  const session = getSession(registry, scopeKey, false);
  if (session) session.selectedPath = null;
};
