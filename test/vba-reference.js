// A faithful transcription of the VBA original, bugs included.
//
// This exists so the port can be diffed against the source of truth
// automatically. Every divergence between this file and src/ is deliberate and
// listed in docs/TECHNICAL.md; the test suite fails if an undeclared one appears.

export function cleanNameVba(nameString) {
  let cleaned = String(nameString ?? "").toLowerCase();
  cleaned = cleaned.replace(/ä/g, "ae").replace(/ö/g, "oe")
                   .replace(/ü/g, "ue").replace(/ß/g, "ss");
  let out = "";
  for (const ch of cleaned) {
    const c = ch.charCodeAt(0);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) out += ch;
  }
  return out;
}

export function levenshteinVba(s1, s2) {
  const d = [];
  for (let i = 0; i <= s1.length; i++) d.push(new Array(s2.length + 1).fill(0));
  for (let i = 0; i <= s1.length; i++) d[i][0] = i;
  for (let j = 0; j <= s2.length; j++) d[0][j] = j;
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[s1.length][s2.length];
}

export function modifiedVba(s1, s2) {
  const maxLen = Math.max(s1.length, s2.length);
  const minLen = Math.min(s1.length, s2.length);
  if (maxLen === 0) return 0;
  return 1 - (levenshteinVba(s1, s2) - Math.abs(s1.length - s2.length)) / minLen;
}
