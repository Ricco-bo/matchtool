// Port of CleanName_cleaned from the VBA original.
//
// Order matters. German umlauts must expand to two letters (ä -> ae) BEFORE
// generic accent folding, otherwise NFD decomposition would strip the diaeresis
// and leave a bare "a". Everything outside [a-z0-9] is then dropped, which is
// what makes the metric blind to spacing, punctuation and legal-form commas.

const UMLAUTS = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [/ß/g, "ss"],
];

/**
 * Fold a raw name down to the comparison alphabet [a-z0-9].
 * @param {string} s
 * @returns {string}
 */
export function cleanName(s) {
  // NFC first: an "ä" typed as "a" + combining diaeresis would otherwise slip
  // past the umlaut rules and lose its "e".
  let x = String(s ?? "").toLowerCase().normalize("NFC");

  for (const [re, rep] of UMLAUTS) x = x.replace(re, rep);

  // Remaining accents fold to their base letter: é -> e, ç -> c, ñ -> n.
  x = x.normalize("NFD").replace(/[̀-ͯ]/g, "");

  return x.replace(/[^a-z0-9]/g, "");
}

// Comparison alphabet: a-z then 0-9. Used for the character-count prefilter.
const ALPHABET_SIZE = 36;

/**
 * Character histogram over the cleaned alphabet.
 * @param {string} cleaned output of cleanName
 * @returns {Int32Array} length 36
 */
export function charCounts(cleaned) {
  const counts = new Int32Array(ALPHABET_SIZE);
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned.charCodeAt(i);
    if (c >= 97) counts[c - 97] += 1;        // a-z -> 0..25
    else counts[26 + (c - 48)] += 1;         // 0-9 -> 26..35
  }
  return counts;
}

/**
 * Characters of the shorter string with no counterpart in the longer one.
 *
 * This is a lower bound on `lev - |len1 - len2|`, the numerator of the metric:
 * writing u for this value and v for the reverse direction, v - u is exactly
 * the length difference, and lev >= max(u, v) = u + |Δlen|.
 *
 * Cheap to compute and exact, so it prunes candidate pairs without ever
 * changing a result.
 */
export function unmatchedChars(countsShort, countsLong) {
  let u = 0;
  for (let c = 0; c < ALPHABET_SIZE; c++) {
    const diff = countsShort[c] - countsLong[c];
    if (diff > 0) u += diff;
  }
  return u;
}
