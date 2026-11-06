// Builds the fixture for checking this port against the VBA original.
//
//   node examples/make-parity.js
//
// Writes examples/parity.xlsx laid out exactly like the VBA's input sheet
// (headings in row 3, data from row 4: A = Name 1, B = ID 1, C = Name 2,
// D = ID 2) plus the same two lists as CSVs for this tool.
//
// The cases are chosen to hit every behaviour the two implementations could
// disagree about, including the three defects fixed in the port.

import { writeFileSync } from "node:fs";
import { writeXlsx } from "../src/xlsx.js";
import { toCsv } from "../src/csv.js";

const LIST_A = [
  ["Müller Handels GmbH", "A001"],          // umlaut vs ue spelling
  ["Schmidt Industrieanlagen AG", "A002"],  // legal form dropped on the other side
  ["Weiß & Söhne KG", "A003"],              // ß, and KG written out
  ["Kärcher Reinigungstechnik GmbH", "A004"], // case difference only
  ["Société Générale S.A.", "A005"],        // accents that are not umlauts
  ["Hoffmann Logistik GmbH & Co. KG", "A006"], // doubled letters + long suffix
  ["Zimmermann Stahlbau GmbH", "A007"],     // single-character typo
  ["Grünewald Pharma GmbH", "A008"],        // no counterpart at all
  ["Müller Handels GmbH", "A009"],          // duplicate of A001, must agree with it
  ["AG", "A010"],                           // short name: subsequence of many
  ["???", "A011"],                          // cleans to empty
  ["Thyssen Fördertechnik AG", "A012"],     // trailing addition on the other side
];

const LIST_B = [
  ["Mueller Handels GmbH", "B001"],
  ["Schmidt Industrieanlagen", "B002"],
  ["Weiss & Soehne Kommanditgesellschaft", "B003"],
  ["KÄRCHER REINIGUNGSTECHNIK GMBH", "B004"],
  ["Societe Generale SA", "B005"],
  ["Hofmann Logistik", "B006"],
  ["Zimmerman Stahlbau GmbH", "B007"],
  ["Völlig andere Firma SE", "B008"],
  ["Müller Gesellschaft mit beschränkter Haftung", "B009"],
  ["Thyssen Fördertechnik AG, Deutschland", "B010"],
  ["", "B011"],                             // blank row
];

const rows = [];
rows.push([]);                              // row 1
rows.push([]);                              // row 2
rows.push(["Name 1", "ID 1", "Name 2", "ID 2"]);   // row 3: the VBA's headings
for (let i = 0; i < Math.max(LIST_A.length, LIST_B.length); i++) {
  rows.push([
    LIST_A[i]?.[0] ?? "", LIST_A[i]?.[1] ?? "",
    LIST_B[i]?.[0] ?? "", LIST_B[i]?.[1] ?? "",
  ]);
}

writeFileSync("examples/parity.xlsx", await writeXlsx(rows, "Input"));
writeFileSync("examples/parity-a.csv", toCsv([["Name", "ID"], ...LIST_A], ";"));
writeFileSync("examples/parity-b.csv", toCsv([["Name", "ID"], ...LIST_B], ";"));

console.log(`examples/parity.xlsx     ${LIST_A.length} x ${LIST_B.length}, laid out for the VBA sheet`);
console.log("examples/parity-a.csv    list A for this tool");
console.log("examples/parity-b.csv    list B for this tool");
