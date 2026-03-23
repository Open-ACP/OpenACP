import { distance } from "fastest-levenshtein";

export function suggestMatch(
  input: string,
  candidates: string[],
  maxDistance: number = 2,
): string | undefined {
  if (candidates.length === 0) return undefined;

  const lower = input.toLowerCase();

  // Exact match — no suggestion needed
  if (candidates.some((c) => c.toLowerCase() === lower)) return undefined;

  // 1. Prefix match — candidate starts with input
  const prefixMatches = candidates.filter((c) =>
    c.toLowerCase().startsWith(lower),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.sort((a, b) => a.length - b.length)[0];
  }

  // 2. Substring match — candidate contains input (min 3 chars to avoid noise)
  if (lower.length >= 3) {
    const substringMatches = candidates.filter((c) =>
      c.toLowerCase().includes(lower),
    );
    if (substringMatches.length > 0) {
      return substringMatches.sort((a, b) => a.length - b.length)[0];
    }
  }

  // 3. Levenshtein distance
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const effectiveMax = candidate.length <= 3 ? Math.min(maxDistance, 1) : maxDistance;
    const d = distance(lower, candidate.toLowerCase());
    if (d <= effectiveMax && d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  return best;
}
