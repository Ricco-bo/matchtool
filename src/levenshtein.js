// Levenshtein distance: a reference implementation and a bounded one.
//
// The VBA original built the full (len1+1) x (len2+1) matrix and called
// Application.WorksheetFunction.Min once per cell. The reference version here
// is the same algorithm without the COM round-trip; the bounded version is what
// the matcher actually runs.

/**
 * Full Levenshtein distance. Two rolling rows instead of the whole matrix.
 * Kept as the ground truth the bounded version is tested against.
 */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      cur[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/**
 * Levenshtein distance, but only accurate up to `k`.
 *
 * Returns the true distance when it is <= k, and k+1 otherwise. Two shortcuts
 * make this much cheaper than the full matrix:
 *
 *  1. Only the diagonal band |i - j| <= k can hold a value <= k, so cells
 *     outside it are never computed.
 *  2. If every cell in a row already exceeds k, no later row can come back
 *     under it, so we stop.
 *
 * Exact for the only question the matcher asks: "is this pair good enough, and
 * if so, by exactly how much?"
 */
export function levenshteinUpTo(a, b, k) {
  const m = a.length;
  const n = b.length;
  if (k < 0) return 1;
  if (Math.abs(m - n) > k) return k + 1;
  if (m === 0) return n <= k ? n : k + 1;
  if (n === 0) return m <= k ? m : k + 1;

  const INF = k + 1;
  let prev = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);

  prev.fill(INF);
  for (let j = 0; j <= n && j <= k; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(n, i + k);
    cur.fill(INF);
    cur[0] = i <= k ? i : INF;

    let best = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      let v = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      if (v > INF) v = INF;          // clamp: neighbours outside the band are INF
      cur[j] = v;
      if (v < best) best = v;
    }

    if (best > k) return k + 1;       // whole row is already out of reach
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  return prev[n] > k ? k + 1 : prev[n];
}
