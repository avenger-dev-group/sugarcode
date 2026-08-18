export type GlobalSearchCandidate = Readonly<{
  id: string;
  label: string;
  description: string;
  keywords?: readonly string[];
  intrinsicRecencyMs?: number;
}>;

export type RecentGlobalSearchItems = Readonly<Record<string, number>>;

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .toLocaleLowerCase()
    .replace(/[\s_-]+/gu, ' ')
    .trim();

const orderedMatch = (value: string, query: string): boolean => {
  let offset = 0;
  for (const character of query) {
    offset = value.indexOf(character, offset);
    if (offset < 0) return false;
    offset += character.length;
  }
  return true;
};

export const globalSearchScore = (
  candidate: GlobalSearchCandidate,
  query: string,
  recentlyUsedAtMs = 0,
): number => {
  const normalizedQuery = normalize(query);
  const label = normalize(candidate.label);
  const description = normalize(candidate.description);
  const keywords = normalize((candidate.keywords ?? []).join(' '));
  const searchable = `${label} ${description} ${keywords}`.trim();
  let relevance = 0;
  if (!normalizedQuery) relevance = 1;
  else if (label === normalizedQuery) relevance = 1_000;
  else if (label.startsWith(normalizedQuery)) relevance = 850;
  else if (label.includes(normalizedQuery)) relevance = 700;
  else if (searchable.includes(normalizedQuery)) relevance = 500;
  else if (orderedMatch(label, normalizedQuery)) relevance = 320;
  else if (orderedMatch(searchable, normalizedQuery)) relevance = 180;
  else return Number.NEGATIVE_INFINITY;

  const recency = Math.max(recentlyUsedAtMs, candidate.intrinsicRecencyMs ?? 0);
  const recencyWeight = recency > 0
    ? Math.min(90, Math.max(0, 90 - (Date.now() - recency) / 86_400_000))
    : 0;
  return relevance + recencyWeight;
};

export const rankGlobalSearchCandidates = <T extends GlobalSearchCandidate>(
  candidates: readonly T[],
  query: string,
  recent: RecentGlobalSearchItems,
): readonly T[] => candidates
  .map((candidate, order) => ({
    candidate,
    order,
    score: globalSearchScore(candidate, query, recent[candidate.id]),
  }))
  .filter((entry) => Number.isFinite(entry.score))
  .sort((left, right) =>
    right.score - left.score || left.order - right.order ||
    left.candidate.label.localeCompare(right.candidate.label))
  .map((entry) => entry.candidate);

export const parseRecentGlobalSearchItems = (
  value: string | null,
): RecentGlobalSearchItems => {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([id, timestamp]) =>
          id.length <= 160 && Number.isSafeInteger(timestamp) && Number(timestamp) > 0)
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .slice(0, 100),
    );
  } catch {
    return {};
  }
};

export const recordRecentGlobalSearchItem = (
  recent: RecentGlobalSearchItems,
  id: string,
  now = Date.now(),
): RecentGlobalSearchItems => parseRecentGlobalSearchItems(JSON.stringify({
  ...recent,
  [id]: now,
}));
