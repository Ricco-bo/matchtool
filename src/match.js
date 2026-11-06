// The n x m matcher.
//
// The VBA original materialised every pair into a worksheet and sorted the lot.
// That is fine for a few hundred rows and impossible for tens of thousands, so
// this keeps only each name's best candidates and prunes pairs that provably
// cannot reach the threshold.
//
// Note on pruning: the usual "skip pairs whose lengths differ by more than k"
// trick does NOT apply to this metric. Tolerating length differences is the
// whole point of it — a 7-character name can legitimately score 1.0 against a
// 60-character one. The character-count bound in unmatchedChars is used instead,
// and it prunes on genuine mismatch rather than on length.

import { cleanName, charCounts, unmatchedChars } from "./normalize.js";
import { levenshteinUpTo } from "./levenshtein.js";
import { metric, maxDistanceFor, compareCandidates } from "./metric.js";

/**
 * Default absolute cap on raw character distance.
 *
 * Set to admit a fully written-out legal form: "Müller GmbH" against
 * "Müller Gesellschaft mit beschränkter Haftung" is 31 characters apart and has
 * to survive. Anything much tighter throws away the abbreviation handling that
 * makes the metric worth having.
 */
export const DEFAULT_MAX_DISTANCE = 35;

/**
 * Default cap relative to the shorter name: at most this many edits per
 * character of it.
 *
 * An absolute cap alone cannot serve both ends. Wide enough for a written-out
 * legal form, it is also wide enough for "AG" to reach almost any company name,
 * because a two-letter string is a subsequence of nearly everything. Scaling by
 * the shorter name separates the two cases cleanly — measured on real pairs:
 *
 *   Müller GmbH / Müller Gesellschaft mit beschränkter Haftung   2.8x
 *   Weiß & Söhne KG / Weiss & Soehne Kommanditgesellschaft       1.5x
 *   Hoffmann Logistik GmbH & Co. KG / Hofmann Logistik           0.6x
 *   -------------------------------------------------------------- 3.0
 *   AG / Müller Handels GmbH                                     8.0x
 *   SE / Thyssen Fördertechnik                                   9.5x
 *   KG / Grünewald Pharma Gesellschaft                          13.5x
 *
 * Every legitimate expansion sits below 3, every short-name false positive well
 * above it. A two-letter name gets a budget of 6 characters; a twenty-letter one
 * gets 60, bounded by DEFAULT_MAX_DISTANCE.
 */
export const DEFAULT_MAX_DISTANCE_RATIO = 3;

/**
 * @typedef {{name: string, id: string|number, index: number}} Row
 */

/** Attach the cleaned form and character histogram to each row, once. */
export function prepare(rows) {
  return rows.map((r, i) => {
    const cleaned = cleanName(r.name);
    return {
      ...r,
      index: r.index ?? i,
      cleaned,
      counts: charCounts(cleaned),
    };
  });
}

/**
 * Best `topN` candidates from `listB` for every row of `listA`.
 *
 * @param {Row[]} listA
 * @param {Row[]} listB
 * @param {{topN?: number, minMetric?: number}} [opts]
 */
export function matchAll(listA, listB, opts = {}) {
  const topN = opts.topN ?? 1;
  const minMetric = opts.minMetric ?? 0;
  // Two caps on raw edits, whichever is tighter for the pair at hand. The metric
  // alone is permissive for short names — it reaches 1.0 whenever the shorter
  // name is a subsequence of the longer — so the "# Different Chars" column
  // becomes a filter rather than just a hint.
  const maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const maxDistanceRatio = opts.maxDistanceRatio ?? DEFAULT_MAX_DISTANCE_RATIO;

  const A = prepare(listA);
  const B = prepare(listB);

  // Identical cleaned names always produce identical results, so compute each
  // distinct one once. This is what the dictH bookkeeping in the VBA was for,
  // except here it falls out of the structure instead of being maintained by hand.
  const cache = new Map();

  return A.map((a) => {
    let candidates = cache.get(a.cleaned);
    if (!candidates) {
      candidates = candidatesFor(a, B, topN, minMetric, maxDistance, maxDistanceRatio);
      cache.set(a.cleaned, candidates);
    }
    return { a, candidates };
  });
}

function candidatesFor(a, B, topN, minMetric, maxDistance, maxDistanceRatio) {
  const out = [];
  const lenA = a.cleaned.length;

  for (const b of B) {
    const lenB = b.cleaned.length;
    if (lenA === 0 || lenB === 0) continue;   // an empty name matches nothing

    // Cheap exact bound first: characters of the shorter name that the longer
    // one simply does not contain. Each one costs at least one edit beyond the
    // length difference, so if there are too many, the pair cannot qualify.
    const budget = (1 - minMetric) * Math.min(lenA, lenB);
    const [shortC, longC] =
      lenA <= lenB ? [a.counts, b.counts] : [b.counts, a.counts];
    if (unmatchedChars(shortC, longC) > budget) continue;

    const k = Math.min(
      maxDistanceFor(lenA, lenB, minMetric),
      maxDistance,
      Math.floor(maxDistanceRatio * Math.min(lenA, lenB)),
    );
    const distance = levenshteinUpTo(a.cleaned, b.cleaned, k);
    if (distance > k) continue;               // below threshold

    const m = metric(distance, lenA, lenB);
    if (m < minMetric) continue;

    out.push({
      b,
      index: b.index,
      distance,
      metric: m,
      exact: distance === 0 && m === 1,
    });
  }

  out.sort(compareCandidates);
  return out.slice(0, topN);
}

/**
 * Global one-to-one assignment.
 *
 * Taking each row's own best candidate independently lets several entries claim
 * the same counterpart, which is wrong for reconciliation work — one invoice is
 * one booking, one vendor is one vendor. Here every candidate pair competes
 * globally: the strongest pairs claim first, and each side is used once.
 *
 * @param {ReturnType<typeof matchAll>} matched
 */
export function assignOneToOne(matched) {
  const pairs = [];
  for (const { a, candidates } of matched) {
    for (const c of candidates) pairs.push({ a, ...c });
  }
  pairs.sort(compareCandidates);

  const takenA = new Set();
  const takenB = new Set();
  const assigned = [];
  for (const p of pairs) {
    if (takenA.has(p.a.index) || takenB.has(p.b.index)) continue;
    takenA.add(p.a.index);
    takenB.add(p.b.index);
    assigned.push(p);
  }

  const unmatched = matched
    .filter(({ a }) => !takenA.has(a.index))
    .map(({ a }) => a);

  return { assigned, unmatched };
}

// ---------------------------------------------------------------- output
//
// The export carries every column of both source rows, not just the two names
// that were matched on. Someone reconciling a real vendor master has ten other
// columns in that file and needs them beside the match — otherwise the result
// has to be VLOOKUPed back against the original, which is the problem this tool
// exists to remove.

const SCORE_COLUMNS = ["Cleaned A", "Cleaned B", "# Different Chars", "Metric in %", "Status"];

/** Heading row. Prefixed, so two columns both called "Name" stay apart. */
export function exportColumns(headersA, headersB) {
  return [
    ...headersA.map((h) => `A · ${h}`),
    ...headersB.map((h) => `B · ${h}`),
    ...SCORE_COLUMNS,
  ];
}

/**
 * One output row.
 * @param a         the prepared list A row
 * @param candidate the chosen candidate, or null for no match
 * @param widthB    how many columns list B has, so blanks line up
 * @param status    free text for the last column
 */
export function exportRow(a, candidate, widthB, status) {
  return [
    ...a.source,
    ...(candidate ? candidate.b.source : Array(widthB).fill("")),
    a.cleaned,
    candidate ? candidate.b.cleaned : "",
    candidate ? candidate.distance : "",
    candidate ? candidate.metric : "",
    status,
  ];
}
