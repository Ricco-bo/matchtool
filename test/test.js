import assert from "node:assert/strict";
import { cleanName, charCounts, unmatchedChars } from "../src/normalize.js";
import { levenshtein, levenshteinUpTo } from "../src/levenshtein.js";
import { metric, maxDistanceFor } from "../src/metric.js";
import {
  matchAll, assignOneToOne, DEFAULT_MAX_DISTANCE, DEFAULT_MAX_DISTANCE_RATIO,
} from "../src/match.js";
import { align } from "../src/align.js";
import { readXlsx, writeXlsx, columnName } from "../src/xlsx.js";
import { zip, unzip, crc32 } from "../src/zip.js";
import { cleanNameVba, levenshteinVba, modifiedVba } from "./vba-reference.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${e.message.split("\n")[0]}`); }
}

// ---------------------------------------------------------------- normalize

test("umlauts expand to two letters", () => {
  assert.equal(cleanName("Müller"), "mueller");
  assert.equal(cleanName("Schröder"), "schroeder");
  assert.equal(cleanName("Kärcher"), "kaercher");
  assert.equal(cleanName("Weiß"), "weiss");
});

test("uppercase umlauts too", () => {
  assert.equal(cleanName("MÜLLER ÖL AG"), "muelleroelag");
});

test("decomposed umlauts survive (a + combining diaeresis)", () => {
  assert.equal(cleanName("Müller"), "mueller");     // would be "muller" without NFC
});

test("other accents fold to the base letter", () => {
  assert.equal(cleanName("José Peña"), "josepena");
  assert.equal(cleanName("Société Générale"), "societegenerale");
  assert.equal(cleanName("Nestlé"), "nestle");
});

test("punctuation, spacing and legal-form commas drop out", () => {
  assert.equal(cleanName("Müller Handels GmbH & Co. KG"), "muellerhandelsgmbhcokg");
  assert.equal(cleanName("  A.B.C  "), "abc");
});

test("matches the VBA cleaner on plain ASCII and umlauts", () => {
  for (const s of ["Müller GmbH", "Schmidt AG", "Weiß & Söhne", "ACME 42", ""]) {
    assert.equal(cleanName(s), cleanNameVba(s), s);
  }
});

// -------------------------------------------------------------- levenshtein

test("levenshtein agrees with the VBA matrix", () => {
  const words = ["mueller", "moeller", "muellergmbh", "schmitt", "schmidt", "", "a", "abc"];
  for (const a of words) for (const b of words) {
    assert.equal(levenshtein(a, b), levenshteinVba(a, b), `${a}|${b}`);
  }
});

test("bounded levenshtein equals the true distance up to k", () => {
  const rnd = mulberry32(42);
  const alpha = "abcde";
  for (let t = 0; t < 4000; t++) {
    const a = randomWord(rnd, alpha, 0, 12);
    const b = randomWord(rnd, alpha, 0, 12);
    const k = Math.floor(rnd() * 8);
    const truth = levenshtein(a, b);
    assert.equal(levenshteinUpTo(a, b, k), Math.min(truth, k + 1), `${a}|${b}|k=${k}`);
  }
});

// ------------------------------------------------------------------- metric

test("trailing content is free", () => {
  assert.equal(metric(levenshtein("muellergmbh", "mueller"), 11, 7), 1);
  assert.equal(metric(levenshtein("mueller", "muellerhandelsgmbhcokg"), 7, 22), 1);
});

test("a plain normalised distance would have buried those", () => {
  const lev = levenshtein("muellergmbh", "mueller");
  assert.ok(1 - lev / 11 < 0.65);          // the conventional score
  assert.equal(metric(lev, 11, 7), 1);     // this one
});

test("single typos score by shorter length", () => {
  assert.ok(Math.abs(metric(levenshtein("schmitt", "schmidt"), 7, 7) - 6 / 7) < 1e-12);
});

test("metric agrees with the VBA formula", () => {
  const words = ["mueller", "moeller", "muellergmbh", "schmitt", "schmidt", "a", "abc", "xyz"];
  for (const a of words) for (const b of words) {
    assert.ok(
      Math.abs(metric(levenshtein(a, b), a.length, b.length) - modifiedVba(a, b)) < 1e-12,
      `${a}|${b}`,
    );
  }
});

test("metric stays inside [0,1] under fuzzing", () => {
  const rnd = mulberry32(7);
  for (let t = 0; t < 3000; t++) {
    const a = randomWord(rnd, "abc", 1, 10);
    const b = randomWord(rnd, "abc", 1, 10);
    const m = metric(levenshtein(a, b), a.length, b.length);
    assert.ok(m >= 0 && m <= 1, `${a}|${b} -> ${m}`);
  }
});

test("maxDistanceFor is the exact cutoff for a threshold", () => {
  const rnd = mulberry32(11);
  for (let t = 0; t < 3000; t++) {
    const a = randomWord(rnd, "abcd", 1, 10);
    const b = randomWord(rnd, "abcd", 1, 10);
    const threshold = rnd();
    const k = maxDistanceFor(a.length, b.length, threshold);
    const lev = levenshtein(a, b);
    const qualifies = metric(lev, a.length, b.length) >= threshold - 1e-12;
    assert.equal(qualifies, lev <= k, `${a}|${b} t=${threshold}`);
  }
});

// ------------------------------------------------------- prefilter is exact

test("character-count prefilter never discards a qualifying pair", () => {
  const rnd = mulberry32(99);
  for (let t = 0; t < 3000; t++) {
    const a = randomWord(rnd, "abcd", 1, 12);
    const b = randomWord(rnd, "abcd", 1, 12);
    const threshold = 0.5 + rnd() * 0.5;
    const [sc, lc] = a.length <= b.length
      ? [charCounts(a), charCounts(b)] : [charCounts(b), charCounts(a)];
    const pruned = unmatchedChars(sc, lc) > (1 - threshold) * Math.min(a.length, b.length);
    if (pruned) {
      assert.ok(metric(levenshtein(a, b), a.length, b.length) < threshold, `${a}|${b}`);
    }
  }
});

// -------------------------------------------------------------- ranking

test("ties on metric are broken by raw distance, exact match first", () => {
  const A = [{ name: "Müller", id: "A1" }];
  const B = [
    { name: "Müller GmbH", id: "B1" },
    { name: "Mueller", id: "B2" },
    { name: "Müllermann", id: "B3" },
  ];
  const [{ candidates }] = matchAll(A, B, { topN: 3, minMetric: 0.5 });
  assert.deepEqual(candidates.map((c) => c.b.id), ["B2", "B1", "B3"]);
  assert.equal(candidates[0].distance, 0);
  assert.ok(candidates.every((c) => c.metric === 1));
});

test("the metric hits 1 exactly when the shorter name is a subsequence", () => {
  // lev == |Δlen| means the pair needs insertions only, i.e. the shorter cleaned
  // name occurs inside the longer one in order. That is the precise rule, and it
  // is why an initialism matches what it stands for.
  const rnd = mulberry32(2024);
  for (let t = 0; t < 2000; t++) {
    const a = randomWord(rnd, "abc", 1, 8);
    const b = randomWord(rnd, "abc", 1, 12);
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const m = metric(levenshtein(a, b), a.length, b.length);
    assert.equal(m === 1, isSubsequence(short, long), `${a}|${b}`);
  }
});

test("GmbH matches what it is short for", () => {
  const A = [{ name: "Müller GmbH", id: "A1" }];
  const B = [{ name: "Müller Gesellschaft mit beschränkter Haftung", id: "B1" }];
  const [{ candidates }] = matchAll(A, B, { topN: 1, minMetric: 0.9 });
  assert.equal(candidates[0].metric, 1);
  assert.equal(candidates[0].distance, 31);
});

test("a different legal form does NOT score 1", () => {
  const A = [{ name: "Müller GmbH", id: "A1" }];
  const B = [{ name: "Müller AG", id: "B1" }];
  const [{ candidates }] = matchAll(A, B, { topN: 1, minMetric: 0.5 });
  assert.ok(Math.abs(candidates[0].metric - 7 / 9) < 1e-12);   // 77.8%
  assert.equal(candidates[0].distance, 4);
});

test("a written-out legal form fits inside the default cap", () => {
  // The reason the default is 35: this pair is 31 characters apart and must live.
  const A = [{ name: "Müller GmbH", id: "A1" }];
  const B = [{ name: "Müller Gesellschaft mit beschränkter Haftung", id: "B1" }];
  const [{ candidates }] = matchAll(A, B, { topN: 1, minMetric: 0.9 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].distance, 31);
  assert.ok(31 <= DEFAULT_MAX_DISTANCE);
});

test("the proportional cap rejects short names that ride the subsequence rule", () => {
  // "ag" is a subsequence of "muellerhandelsgmbh", so the metric says 100% and
  // the 16-character distance clears the absolute cap of 35. 3 x minLen = 6 does
  // not, which is the whole reason the ratio exists.
  const A = [{ name: "AG", id: "A1" }, { name: "SE", id: "A2" }, { name: "KG", id: "A3" }];
  const B = [
    { name: "Müller Handels GmbH", id: "B1" },
    { name: "Thyssen Fördertechnik", id: "B2" },
    { name: "Grünewald Pharma Gesellschaft", id: "B3" },
  ];
  for (const r of matchAll(A, B, { topN: 1, minMetric: 0.9 })) {
    assert.equal(r.candidates.length, 0, r.a.name);
  }

  // ...and it is the ratio doing the work, not the absolute cap.
  const loose = matchAll(A, B, { topN: 1, minMetric: 0.9, maxDistanceRatio: Infinity });
  assert.ok(loose[0].candidates.length > 0);
});

test("legitimate expansions stay under the ratio", () => {
  const pairs = [
    ["Müller GmbH", "Müller Gesellschaft mit beschränkter Haftung"],
    ["Weiß & Söhne KG", "Weiss & Soehne Kommanditgesellschaft"],
    ["Hoffmann Logistik GmbH & Co. KG", "Hofmann Logistik"],
    ["Siemens AG", "Siemens Energy AG"],
  ];
  for (const [x, y] of pairs) {
    const [{ candidates }] = matchAll([{ name: x }], [{ name: y }], {
      topN: 1, minMetric: 0.9,
    });
    assert.equal(candidates.length, 1, `${x} || ${y}`);
  }
});

test("the defaults are 35 characters and 3x the shorter name", () => {
  assert.equal(DEFAULT_MAX_DISTANCE, 35);
  assert.equal(DEFAULT_MAX_DISTANCE_RATIO, 3);
});

test("maxDistance never changes which of the survivors ranks first", () => {
  const A = [{ name: "Müller", id: "A1" }];
  const B = [
    { name: "Müller GmbH", id: "B1" },
    { name: "Mueller", id: "B2" },
  ];
  const capped = matchAll(A, B, { topN: 2, minMetric: 0.5, maxDistance: 6 });
  assert.deepEqual(capped[0].candidates.map((c) => c.b.id), ["B2", "B1"]);
});

// ------------------------------------------------- divergences from the VBA

test("FIX: an empty name no longer matches everything at 100%", () => {
  assert.equal(modifiedVba("", ""), 0);
  const A = [{ name: "???", id: "A1" }];        // cleans to ""
  const B = [{ name: "Müller GmbH", id: "B1" }];
  const [{ candidates }] = matchAll(A, B, { topN: 1, minMetric: 0 });
  assert.equal(candidates.length, 0);
  assert.equal(metric(1, 0, 11), 0);            // VBA wrote 1 here
});

test("FIX: short second lists keep their last group", () => {
  const A = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
  const B = [{ name: "Alpha" }, { name: "Gamma" }];   // stepSize 2, under the VBA's 5
  const out = matchAll(A, B, { topN: 1, minMetric: 0.5 });
  assert.equal(out.length, 3);
  assert.equal(out[2].candidates[0].b.name, "Gamma");
});

test("FIX: topN larger than the second list does not corrupt output", () => {
  const A = [{ name: "Alpha" }];
  const B = [{ name: "Alpha" }, { name: "Alpine" }];
  const out = matchAll(A, B, { topN: 10, minMetric: 0 });
  assert.ok(out[0].candidates.length <= 2);
  assert.equal(out[0].candidates[0].b.name, "Alpha");
});

// ---------------------------------------------------------------- alignment

test("alignment keeps every character and flags the differing ones", () => {
  const { a, b } = align("schmitt", "schmidt");
  assert.equal(a.map((x) => x.ch).join(""), "schmitt");
  assert.equal(b.map((x) => x.ch).join(""), "schmidt");
  assert.equal(a.filter((x) => !x.match).length, 1);
  assert.equal(b.filter((x) => !x.match).length, 1);
});

test("a subsequence match marks the whole shorter name", () => {
  const { a, b } = align("gmbh", "gesellschaftmitbeschraenkterhaftung");
  assert.ok(a.every((x) => x.match));
  assert.equal(b.filter((x) => x.match).length, 4);
});

test("alignment is consistent with the distance", () => {
  const rnd = mulberry32(5);
  for (let t = 0; t < 500; t++) {
    const x = randomWord(rnd, "abc", 0, 10);
    const y = randomWord(rnd, "abc", 0, 10);
    const { a, b } = align(x, y);
    assert.equal(a.map((c) => c.ch).join(""), x);
    assert.equal(b.map((c) => c.ch).join(""), y);
    // The matched characters pair up one-for-one and spell the same string on
    // both sides, and neither side can show more differences than there are edits.
    const keptA = a.filter((c) => c.match).map((c) => c.ch).join("");
    const keptB = b.filter((c) => c.match).map((c) => c.ch).join("");
    assert.equal(keptA, keptB, `${x}|${y}`);
    const dist = levenshtein(x, y);
    assert.ok(a.filter((c) => !c.match).length <= dist, `${x}|${y}`);
    assert.ok(b.filter((c) => !c.match).length <= dist, `${x}|${y}`);
  }
});

// -------------------------------------------------------- one-to-one mode

test("one-to-one assignment stops two names claiming the same counterpart", () => {
  const A = [{ name: "Müller GmbH", id: "A1" }, { name: "Mueller", id: "A2" }];
  const B = [{ name: "Müller", id: "B1" }, { name: "Müller Handels GmbH", id: "B2" }];
  const matched = matchAll(A, B, { topN: 2, minMetric: 0.5 });
  const { assigned, unmatched } = assignOneToOne(matched);
  assert.equal(unmatched.length, 0);
  assert.equal(new Set(assigned.map((p) => p.b.id)).size, assigned.length);
  assert.equal(assigned.length, 2);
});

test("duplicate names in the first list get identical results", () => {
  const A = [{ name: "Müller GmbH" }, { name: "Mueller  gmbh" }];
  const B = [{ name: "Müller Handels GmbH" }, { name: "Schmidt AG" }];
  const out = matchAll(A, B, { topN: 1, minMetric: 0.5 });
  assert.deepEqual(
    out[0].candidates.map((c) => [c.distance, c.metric]),
    out[1].candidates.map((c) => [c.distance, c.metric]),
  );
});

// ----------------------------------------------------------------- xlsx/zip

const asyncTests = [];
const atest = (name, fn) => asyncTests.push([name, fn]);

atest("zip round-trips, and entries survive deflate", async () => {
  const enc = new TextEncoder();
  const files = [
    { name: "a.txt", data: enc.encode("x".repeat(5000)) },   // compresses hard
    { name: "dir/b.bin", data: new Uint8Array([0, 1, 2, 255]) },
  ];
  const back = await unzip(await zip(files));
  assert.equal(back.size, 2);
  assert.equal(new TextDecoder().decode(back.get("a.txt")), "x".repeat(5000));
  assert.deepEqual([...back.get("dir/b.bin")], [0, 1, 2, 255]);
});

atest("crc32 matches the known check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

atest("xlsx round-trips text, umlauts, XML metacharacters and numbers", async () => {
  const rows = [
    ["Name", "ID", "# Different Chars", "Metric in %"],
    ["Müller & Söhne <GmbH>", "A001", 0, 1],
    ['Weiß "KG"', "B002", 19, 0.8571],
    ["", "", "", ""],
  ];
  const sheets = await readXlsx(await writeXlsx(rows, "Matches"));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "Matches");
  const grid = sheets[0].grid;
  assert.equal(grid[1][0], "Müller & Söhne <GmbH>");
  assert.equal(grid[2][0], 'Weiß "KG"');
  assert.equal(grid[1][2], "0");
  assert.equal(grid[2][3], "0.8571");
});

atest("IDs that merely look numeric stay text", async () => {
  // "007" written as a numeric cell displays as 7 in Excel, which silently
  // corrupts the ID column. Check the cell type in the XML, not just what our
  // own reader gives back.
  const files = await unzip(await writeXlsx([["007", "1e5", "19", -2.5, "Müller"]]));
  const xml = new TextDecoder().decode(files.get("xl/worksheets/sheet1.xml"));
  assert.match(xml, /<c r="A1" t="inlineStr">/);   // 007 -> text
  assert.match(xml, /<c r="B1" t="inlineStr">/);   // 1e5 -> text
  assert.match(xml, /<c r="C1"><v>19<\/v>/);       // 19  -> number
  assert.match(xml, /<c r="D1"><v>-2.5<\/v>/);     // -2.5 -> number

  const sheets = await readXlsx(await writeXlsx([["A", "007"]]));
  assert.equal(sheets[0].grid[0][1], "007");
});

atest("xlsx handles more than 26 columns", async () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(27), "AB");
  const wide = [Array.from({ length: 30 }, (_, i) => `c${i}`)];
  const sheets = await readXlsx(await writeXlsx(wide));
  assert.equal(sheets[0].grid[0].length, 30);
  assert.equal(sheets[0].grid[0][29], "c29");
});

atest("a matched result set survives the Excel round-trip", async () => {
  const A = [{ name: "Müller GmbH", id: "A1" }];
  const B = [{ name: "Mueller  Gmbh", id: "B1" }];
  const [{ a, candidates }] = matchAll(A, B, { topN: 1, minMetric: 0.8 });
  const grid = [["Name 1", "Name 2", "Chars"], [a.name, candidates[0].b.name, candidates[0].distance]];
  const back = await readXlsx(await writeXlsx(grid));
  assert.deepEqual(back[0].grid[1], ["Müller GmbH", "Mueller  Gmbh", "0"]);
});

// ------------------------------------------------------------------- build

atest("the bundle parses, and $$ survives the inlining", async () => {
  // A string replacement treats "$$" as an escaped "$", which silently rewrote
  // `const $$ = ...` into a second `const $ = ...` and made every build of the
  // standalone file unparseable. Both halves are checked: that the build runs
  // (it compiles its own output now) and that the source came through intact.
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));

  execFileSync(process.execPath, ["build.js"], { cwd: root, stdio: "pipe" });

  const html = readFileSync(`${root}dist/matchtool.html`, "utf8");
  assert.ok(html.includes("const $$ = "), "$$ was mangled by the inlining");
  assert.equal((html.match(/^const \$ = /gm) ?? []).length, 1);
  assert.ok(!html.includes('<script type="module" src='), "script not inlined");
  assert.ok(!html.includes('<link rel="stylesheet"'), "stylesheet not inlined");

  const landing = readFileSync(`${root}dist/index.html`, "utf8");
  assert.ok(!landing.includes('<link rel="stylesheet"'), "landing css not inlined");
  assert.match(landing, /href="matchtool\.html"/);
});

// ------------------------------------------------------------------ helpers

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isSubsequence(short, long) {
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) {
    if (short[i] === long[j]) i++;
  }
  return i === short.length;
}

function randomWord(rnd, alphabet, min, max) {
  const len = min + Math.floor(rnd() * (max - min + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}

// ------------------------------------------------------------------- report

for (const [name, fn] of asyncTests) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${e.message.split("\n")[0]}`); }
}

if (failures.length) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`${passed} tests passed`);
