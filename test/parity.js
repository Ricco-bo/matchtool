#!/usr/bin/env node
// Diff this port against the VBA original on the same input.
//
//   1. node examples/make-parity.js
//   2. open examples/parity.xlsx, paste A1:D15 into your matcher's input sheet
//   3. run AskAndRun with 1 result per name
//   4. select H3:P<last>, copy, paste into a new sheet, save as CSV
//   5. node test/parity.js <that-file.csv>
//
// Compares the match each side chose and the character distance it reported.
// The metric column is ignored on purpose: Excel formats it as a percentage and
// the rounding is not worth arguing with — if the chosen row and the distance
// agree, the metric did too.
//
// Runs with every filter switched off, because the VBA has none: it returns the
// best match for every name whatever the score. This compares the algorithm,
// not the thresholds added since.

import { readFileSync } from "node:fs";
import { parseCsv, sniffDelimiter } from "../src/csv.js";
import { matchAll } from "../src/match.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node test/parity.js <vba-output.csv>");
  process.exit(2);
}

const text = readFileSync(path, "utf8");
const grid = parseCsv(text, sniffDelimiter(text)).filter((r) => r.some((c) => c.trim() !== ""));

// Tolerate the heading row being present or not.
const looksLikeHeading = /name/i.test(grid[0]?.[0] ?? "");
const body = looksLikeHeading ? grid.slice(1) : grid;

const vba = body.map((r) => ({
  name1: (r[0] ?? "").trim(),
  name2: (r[2] ?? "").trim(),
  distance: (r[6] ?? "").trim(),
}));

function load(file) {
  const raw = readFileSync(file, "utf8");
  const rows = parseCsv(raw, sniffDelimiter(raw)).slice(1);
  return rows
    .map((r, i) => ({ name: (r[0] ?? "").trim(), id: (r[1] ?? "").trim(), index: i }))
    .filter((r) => r.name !== "");
}

const matched = matchAll(load("examples/parity-a.csv"), load("examples/parity-b.csv"), {
  topN: 1,
  minMetric: 0,
  maxDistance: Infinity,
  maxDistanceRatio: Infinity,
});

const mine = new Map();
for (const m of matched) {
  const top = m.candidates[0];
  mine.set(m.a.name, { name2: top ? top.b.name : "", distance: top ? String(top.distance) : "" });
}

let same = 0;
const differ = [];
for (const row of vba) {
  const ours = mine.get(row.name1);
  if (!ours) {
    differ.push([row.name1, `${row.name2} (${row.distance})`, "— not in list A —"]);
    continue;
  }
  if (ours.name2 === row.name2 && ours.distance === row.distance) same++;
  else differ.push([row.name1, `${row.name2} (${row.distance})`, `${ours.name2} (${ours.distance})`]);
}

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
console.log(`${same} of ${vba.length} rows identical\n`);
if (differ.length) {
  console.log(`${pad("Name 1", 32)}${pad("VBA chose", 30)}matchtool chose`);
  console.log("-".repeat(96));
  for (const [a, b, c] of differ) console.log(`${pad(a, 32)}${pad(b, 30)}${c}`);
  console.log(`
Differences are not automatically bugs. Expected ones, all documented in README:
  - a name that cleans to empty: the VBA scored it 1.0 and matched it to
    whatever came first; this returns no match
  - the last group when list B has fewer than 5 rows: the VBA dropped it
If anything else differs, that is worth looking at.`);
}
