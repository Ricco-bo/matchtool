// Scale check: how long n x m takes, and how much the prefilter saves.
import { matchAll } from "../src/match.js";

const SYLL = ["mue","ller","schmi","dt","hoff","mann","zimmer","bau","stahl","pharma",
              "logis","tik","tech","nik","gruen","wald","kaer","cher","nord","sued"];
const SUFFIX = [" GmbH", " AG", " KG", " GmbH & Co. KG", " SE", ""];

function rnd(seed) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function makeList(n, seed) {
  const r = rnd(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let name = "";
    const parts = 2 + Math.floor(r() * 3);
    for (let p = 0; p < parts; p++) name += SYLL[Math.floor(r() * SYLL.length)];
    name += SUFFIX[Math.floor(r() * SUFFIX.length)];
    out.push({ name, id: `X${i}` });
  }
  return out;
}

for (const n of [500, 1000, 2000, 4000]) {
  const A = makeList(n, 1);
  const B = makeList(n, 99);
  const t0 = Date.now();
  const matched = matchAll(A, B, { topN: 3, minMetric: 0.8, maxDistance: 8 });
  const ms = Date.now() - t0;
  const hits = matched.filter((m) => m.candidates.length > 0).length;
  const pairs = n * n;
  console.log(
    `${String(n).padStart(5)} x ${String(n).padEnd(5)} = ${String(pairs).padStart(10)} pairs   ` +
    `${String(ms).padStart(6)} ms   ${(pairs / ms / 1000).toFixed(0)}M pairs/s   ${hits} matched`,
  );
}
