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
