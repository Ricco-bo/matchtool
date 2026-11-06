// The matching metric, ported from ModifiedLevenshteinDistance_cleaned.
//
//     metric = 1 - (lev - |len1 - len2|) / min(len1, len2)
//
// Subtracting the length difference removes the edits forced on the pair purely
// because one string is longer. What remains is the mismatch inside the part the
// two strings share, measured against the shorter string.
//
// The consequence, and the reason this beats a plain 1 - lev/maxLen on business
// data: extra trailing content costs nothing. "muellergmbh" vs "mueller" scores
// 1.0, because every one of the 4 edits is accounted for by the length gap.
//
// Bounded to [0, 1]: lev >= |Δlen| always, and lev - |Δlen| <= minLen.

/**
 * @param {number} lev  Levenshtein distance between the two cleaned names
 * @param {number} len1 length of the first cleaned name
 * @param {number} len2 length of the second cleaned name
 */
export function metric(lev, len1, len2) {
  const minLen = Math.min(len1, len2);
  // Divergence from the VBA: an empty cleaned name scored 1.0 there, i.e. a
  // perfect match against everything, which floated blank rows to the top of
  // every result group. An empty name matches nothing.
  if (minLen === 0) return 0;
  return 1 - (lev - Math.abs(len1 - len2)) / minLen;
}

/**
 * Largest Levenshtein distance that can still reach `minMetric` at these lengths.
 *
 * Solving metric >= t for lev gives lev <= |Δlen| + (1 - t) * minLen, so the
 * bounded distance function can be told exactly when to give up — per pair,
 * before any matrix work.
 */
export function maxDistanceFor(len1, len2, minMetric) {
  const minLen = Math.min(len1, len2);
  const delta = Math.abs(len1 - len2);
  return Math.floor(delta + (1 - minMetric) * minLen + 1e-9);
}

/**
 * Ranking comparator, ported from the two-key sort in
 * FilterPatternMatchingBroad_cleaned: metric descending, then the raw character
 * distance ascending.
 *
 * The tie-break carries real weight here, because every containment match ties
 * at 1.0 — the raw distance is what puts an exact match above a prefix match
 * above a long trailing extension.
 */
export function compareCandidates(x, y) {
  if (y.metric !== x.metric) return y.metric - x.metric;
  if (x.distance !== y.distance) return x.distance - y.distance;
  return x.index - y.index;          // stable: input order of the second list
}
