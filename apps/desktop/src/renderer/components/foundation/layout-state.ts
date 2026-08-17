export const NAVIGATOR_WIDTH = {
  default: 286,
  min: 240,
  max: 380,
} as const;
export const CONTEXT_RAIL_WIDTH = {
  default: 760,
  min: 380,
  max: 1200,
} as const;

export type StoredLayout = Readonly<{
  navigatorWidth: number;
  navigatorOpen: boolean;
  contextRailWidth: number;
  contextRailOpen: boolean;
}>;

export const DEFAULT_LAYOUT: StoredLayout = {
  navigatorWidth: NAVIGATOR_WIDTH.default,
  navigatorOpen: true,
  contextRailWidth: CONTEXT_RAIL_WIDTH.default,
  contextRailOpen: false,
};

export const MAX_CONTEXT_RAIL_SCOPES = 100;

export const resolveContextRailOpen = (
  visibilityByScope: ReadonlyMap<string, boolean>,
  scopeKey: string | null,
  fallback: boolean,
): boolean => scopeKey === null
  ? fallback
  : visibilityByScope.get(scopeKey) ?? false;

export const updateContextRailVisibility = (
  visibilityByScope: ReadonlyMap<string, boolean>,
  scopeKey: string,
  open: boolean,
): ReadonlyMap<string, boolean> => {
  if (visibilityByScope.get(scopeKey) === open) return visibilityByScope;
  const next = new Map(visibilityByScope);
  next.delete(scopeKey);
  next.set(scopeKey, open);
  while (next.size > MAX_CONTEXT_RAIL_SCOPES) {
    const oldest = next.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
};

const validWidth = (
  value: unknown,
  range: typeof NAVIGATOR_WIDTH | typeof CONTEXT_RAIL_WIDTH,
): number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= range.min &&
  value <= range.max
    ? value
    : range.default;

const validOpen = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export const parseStoredLayout = (value: string | null): StoredLayout => {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_LAYOUT;
    }
    const candidate = parsed as Partial<StoredLayout>;
    return {
      navigatorWidth: validWidth(candidate.navigatorWidth, NAVIGATOR_WIDTH),
      navigatorOpen: validOpen(candidate.navigatorOpen, true),
      contextRailWidth: validWidth(
        candidate.contextRailWidth,
        CONTEXT_RAIL_WIDTH,
      ),
      contextRailOpen: validOpen(candidate.contextRailOpen, false),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
};
