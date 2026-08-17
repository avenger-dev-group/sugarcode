export const isDrawioEdgeLinePath = ({
  data,
  fill,
  stroke,
  visibility,
}: Readonly<{
  data: string | null;
  fill: string | null;
  stroke: string | null;
  visibility: string | null;
}>): boolean =>
  Boolean(data) &&
  stroke !== null &&
  stroke.toLowerCase() !== 'none' &&
  visibility?.toLowerCase() !== 'hidden' &&
  (fill === null || fill === '' || fill.toLowerCase() === 'none');

export const isDrawioFlowAnimationValue = (value: unknown): boolean =>
  value === true || value === 1 || value === '1';

const FLOW_TIMINGS = new Set([
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
]);
const FLOW_DIRECTIONS = new Set([
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
]);

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type DrawioFlowAnimation = Readonly<{
  dashArray: string;
  direction: string;
  durationMs: number;
  offset: number;
  timing: string;
}>;

export const resolveDrawioFlowAnimation = ({
  existingDashArray,
  scale,
  style,
}: Readonly<{
  existingDashArray: string | null;
  scale: number;
  style: Readonly<Record<string, unknown>>;
}>): DrawioFlowAnimation => {
  const safeScale = Math.max(0.01, finiteNumber(scale, 1));
  const source = existingDashArray?.trim() || String(style.dashPattern ?? '8');
  let tokens = source
    .split(/[\s,]+/u)
    .map((token) => finiteNumber(token, 0))
    .filter((token) => token > 0);
  if (!existingDashArray?.trim()) {
    const fixedDash = isDrawioFlowAnimationValue(style.fixDash);
    const strokeWidth = fixedDash || style.dashPattern === undefined
      ? 1
      : Math.max(0.1, finiteNumber(style.strokeWidth, 1));
    tokens = tokens.map((token) =>
      Math.round(token * safeScale * strokeWidth * 100) / 100,
    );
  }
  if (tokens.length === 0) tokens = [8 * safeScale];
  let offset = tokens.reduce((sum, token) => sum + token, 0);
  if (tokens.length % 2 !== 0) offset *= 2;
  const requestedDuration = Math.min(
    10_000,
    Math.max(100, finiteNumber(style.flowAnimationDuration, 500)),
  );
  const durationMs = Math.max(
    100,
    Math.round((offset / safeScale / 16) * requestedDuration),
  );
  const requestedTiming = String(style.flowAnimationTimingFunction ?? 'linear');
  const requestedDirection = String(style.flowAnimationDirection ?? 'normal');
  return {
    dashArray: tokens.join(' '),
    direction: FLOW_DIRECTIONS.has(requestedDirection)
      ? requestedDirection
      : 'normal',
    durationMs,
    offset,
    timing: FLOW_TIMINGS.has(requestedTiming) ? requestedTiming : 'linear',
  };
};
