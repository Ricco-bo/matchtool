#!/usr/bin/env node
// Match two lists of names.
//
//   node cli.js listA.csv listB.csv --out results.csv
//
// Each input is a CSV whose first column is the name and whose optional second
// column is an ID carried through to the output.

import { readFileSync, writeFileSync } from "node:fs";
import { parseCsv, sniffDelimiter, toCsv } from "./src/csv.js";
import { readXlsx, writeXlsx } from "./src/xlsx.js";
import {
  matchAll, assignOneToOne, exportColumns, exportRow,
  DEFAULT_MAX_DISTANCE, DEFAULT_MAX_DISTANCE_RATIO,
} from "./src/match.js";

function parseArgs(argv) {
  const opts = { topN: 1, minMetric: 0.6, maxDistance: DEFAULT_MAX_DISTANCE, maxDistanceRatio: DEFAULT_MAX_DISTANCE_RATIO, header: true, oneToOne: false, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") opts.topN = Number(argv[++i]);
    else if (a === "--min") opts.minMetric = Number(argv[++i]);
    else if (a === "--max-dist") opts.maxDistance = Number(argv[++i]);
    else if (a === "--max-ratio") opts.maxDistanceRatio = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--one-to-one") opts.oneToOne = true;
    else if (a === "--no-header") opts.header = false;
    else if (a.startsWith("-")) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else positional.push(a);
  }
  return { opts, positional };
}

async function load(path, hasHeader) {
  let rows;
  if (/\.xls[xm]$/i.test(path)) {
    const sheets = await readXlsx(readFileSync(path));
    rows = sheets[0].grid;                       // first worksheet
  } else {
    const text = readFileSync(path, "utf8");
    rows = parseCsv(text, sniffDelimiter(text));
  }
  const width = Math.max(...rows.map((r) => r.length), 1);
  const headers = Array.from({ length: width }, (_, c) =>
    (hasHeader && String(rows[0]?.[c] ?? "").trim()) || `Column ${c + 1}`);
  const body = hasHeader ? rows.slice(1) : rows;

  const names = body
    .map((r, i) => ({
      name: String(r[0] ?? "").trim(),
      id: String(r[1] ?? "").trim(),
      index: i,
      // Carried through to the output so the user gets their own columns back.
      source: Array.from({ length: width }, (_, c) => String(r[c] ?? "")),
    }))
    .filter((r) => r.name !== "");

  names.headers = headers;
  return names;
}

const { opts, positional } = parseArgs(process.argv.slice(2));
if (positional.length !== 2) {
  console.error("usage: node cli.js <listA.csv> <listB.csv> [--top N] [--min 0.6] [--max-dist 35] [--max-ratio 3] [--one-to-one] [--no-header] [--out results.xlsx|results.csv]");
  process.exit(2);
}

const started = Date.now();
const listA = await load(positional[0], opts.header);
const listB = await load(positional[1], opts.header);

const matched = matchAll(listA, listB, {
  topN: opts.topN,
  minMetric: opts.minMetric,
  maxDistance: opts.maxDistance,
  maxDistanceRatio: opts.maxDistanceRatio,
});

const widthB = listB.headers.length;
const COLUMNS = exportColumns(listA.headers, listB.headers);

let rows;
let summary;
if (opts.oneToOne) {
  const { assigned, unmatched } = assignOneToOne(matched);
  rows = assigned.map((p) => exportRow(p.a, p, widthB, p.exact ? "exact" : "matched"));
  for (const a of unmatched) rows.push(exportRow(a, null, widthB, "no match"));
  summary = `${assigned.length} assigned, ${unmatched.length} unmatched`;
} else {
  rows = [];
  for (const { a, candidates } of matched) {
    if (candidates.length === 0) rows.push(exportRow(a, null, widthB, "no match"));
    else for (const c of candidates) rows.push(exportRow(a, c, widthB, c.exact ? "exact" : "matched"));
  }
  const withMatch = matched.filter((m) => m.candidates.length > 0).length;
  summary = `${withMatch}/${listA.length} names matched`;
}

// --out something.xlsx writes a workbook; anything else writes CSV.
if (opts.out && /\.xlsx$/i.test(opts.out)) {
  writeFileSync(opts.out, await writeXlsx([COLUMNS, ...rows], "Matches"));
} else {
  const out = toCsv([COLUMNS, ...rows]);
  if (opts.out) writeFileSync(opts.out, out);
  else process.stdout.write(out);
}

const pairs = listA.length * listB.length;
console.error(
  `${listA.length} x ${listB.length} = ${pairs.toLocaleString("en-US")} pairs | ` +
  `${summary} | ${Date.now() - started} ms`
);
