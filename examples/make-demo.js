// Generates a pair of lists with the failure modes this tool exists for:
// umlaut spelling, typos, legal-form drift, truncation, abbreviation, accents.
import { writeFileSync } from "node:fs";
import { toCsv } from "../src/csv.js";

const base = [
  "Müller Handels GmbH", "Schmidt Industrieanlagen AG", "Weiß & Söhne KG",
  "Kärcher Reinigungstechnik GmbH", "Société Générale S.A.", "Nestlé Deutschland AG",
  "Bäcker Krüger OHG", "Hoffmann Logistik GmbH & Co. KG", "Zimmermann Stahlbau GmbH",
  "Österreichische Post AG", "Grünewald Pharma GmbH", "Thyssen Fördertechnik AG",
];

// How the same company tends to look in the other system.
const variants = [
  (s) => s.replace(/ü/g, "ue").replace(/ö/g, "oe").replace(/ä/g, "ae").replace(/ß/g, "ss"),
  (s) => s.replace(/\s*(GmbH|AG|KG|OHG|S\.A\.)(\s*&\s*Co\.\s*KG)?\s*$/i, "").trim(),
  (s) => s.slice(0, 20).trim(),
  (s) => s.replace(/Gesellschaft mit beschränkter Haftung/i, "GmbH").toUpperCase(),
  (s) => s.replace(/tt/, "dt").replace(/mm/, "m"),
  (s) => s + " Gesellschaft mit beschränkter Haftung".slice(0, 0) + ", Deutschland",
];

const listA = base.map((n, i) => [n, `A${String(i + 1).padStart(3, "0")}`]);
const listB = base.map((n, i) => [variants[i % variants.length](n), `B${String(i + 1).padStart(3, "0")}`]);

// Rows that should NOT match anything, plus the empty-name case.
listB.push(["Völlig andere Firma SE", "B900"], ["???", "B901"], ["", "B902"]);

writeFileSync("examples/list-a.csv", toCsv([["Name", "ID"], ...listA]));
writeFileSync("examples/list-b.csv", toCsv([["Name", "ID"], ...listB]));
console.log(`wrote ${listA.length} x ${listB.length}`);
