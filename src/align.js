// Character alignment between two cleaned names, for showing *why* a pair
// matched. Reconstructs the edit script from a full Levenshtein matrix — the
// strings here are short, and this runs only for the handful of pairs on screen.

const MAX_LEN = 300;

/**
 * @returns {{a: {ch: string, match: boolean}[], b: {ch: string, match: boolean}[]}}
 *   one entry per character of each string, flagged with whether it was aligned
 *   against an identical character in the other.
 */
export function align(a, b) {
  if (a.length > MAX_LEN || b.length > MAX_LEN) {
    return {
      a: [...a].map((ch) => ({ ch, match: false })),
      b: [...b].map((ch) => ({ ch, match: false })),
    };
  }

  const m = a.length;
  const n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) {
    d.push(new Int32Array(n + 1));
    d[i][0] = i;
  }
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }

  const outA = [];
  const outB = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const same = i > 0 && j > 0 && a[i - 1] === b[j - 1];
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (same ? 0 : 1)) {
      outA.unshift({ ch: a[i - 1], match: same });
      outB.unshift({ ch: b[j - 1], match: same });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      outA.unshift({ ch: a[i - 1], match: false });   // only in the first name
      i--;
    } else {
      outB.unshift({ ch: b[j - 1], match: false });   // only in the second
      j--;
    }
  }
  return { a: outA, b: outB };
}
