// Read and write .xlsx workbooks.
//
// Scope is deliberately narrow: a worksheet's cell values as text. No styles,
// no formulas, no dates-as-serial-numbers — this tool matches names, and the
// columns it reads hold names and IDs.
//
// Parsing is by regular expression rather than a DOM. Excel's own output is
// regular enough for that, it works identically in Node and the browser, and it
// keeps the dependency count at zero.

import { unzip, zip } from "./zip.js";

const decodeXml = (s) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
   .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
   .replace(/&amp;/g, "&");

const encodeXml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // Control characters are not legal in XML 1.0 and Excel rejects the file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/** "BC12" -> 54 (zero-based column index) */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 -> "A", 26 -> "AA" */
export function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseSharedStrings(xml) {
  const out = [];
  const si = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = si.exec(xml))) {
    let text = "";
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let piece;
    while ((piece = t.exec(m[1]))) text += decodeXml(piece[1]);
    out.push(text);
  }
  return out;
}

function parseSheet(xml, shared) {
  const grid = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let row;
  while ((row = rowRe.exec(xml))) {
    const rowNumber = Number(/\br="(\d+)"/.exec(row[1])?.[1] ?? grid.length + 1);
    const cells = [];

    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cell;
    while ((cell = cellRe.exec(row[2]))) {
      const attrs = cell[1];
      const inner = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const at = ref ? columnIndex(ref) : cells.length;

      let value = "";
      if (type === "inlineStr") {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let piece;
        while ((piece = t.exec(inner))) value += decodeXml(piece[1]);
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw !== undefined) {
          value = type === "s" ? (shared[Number(raw)] ?? "") : decodeXml(raw);
        }
      }

      while (cells.length < at) cells.push("");
      cells[at] = value;
    }

    while (grid.length < rowNumber - 1) grid.push([]);
    grid[rowNumber - 1] = cells;
  }
  return grid;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{name: string, grid: string[][]}[]>} one entry per worksheet
 */
export async function readXlsx(input) {
  const files = await unzip(input);
  const text = (name) => {
    const bytes = files.get(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  };

  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new Error("not an Excel workbook (xl/workbook.xml missing)");

  // Sheet name -> part, resolved through the workbook relationships.
  const rels = new Map();
  const relsXml = text("xl/_rels/workbook.xml.rels") ?? "";
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    let target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (!id || !target) continue;
    if (!target.startsWith("/")) target = `xl/${target.replace(/^\.\//, "")}`;
    rels.set(id, target.replace(/^\//, ""));
  }

  const shared = parseSharedStrings(text("xl/sharedStrings.xml") ?? "");

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? `Sheet${sheets.length + 1}`);
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    const part = (rid && rels.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = text(part);
    if (xml) sheets.push({ name, grid: parseSheet(xml, shared) });
  }

  if (sheets.length === 0) throw new Error("the workbook has no readable worksheet");
  return sheets;
}

// ------------------------------------------------------------------ writing

/**
 * Whether a value should be written as a number rather than text.
 *
 * Round-tripping through Number is the test, not a regexp: "007" and "1e5" both
 * look numeric but do not survive as themselves, and vendor and cost-centre IDs
 * with leading zeros are everywhere in German master data. Turning 007 into 7
 * silently corrupts the column the user matched on.
 */
function isNumeric(value) {
  if (typeof value === "number") return Number.isFinite(value);
  const s = String(value).trim();
  return s !== "" && String(Number(s)) === s;
}

/**
 * One worksheet from a grid of values. Strings are written inline, so there is
 * no shared-string table to keep consistent.
 *
 * @param {(string|number)[][]} rows
 * @param {string} [sheetName]
 * @returns {Promise<Uint8Array>}
 */
export async function writeXlsx(rows, sheetName = "Matches") {
  const body = rows
    .map((cells, r) => {
      const xml = cells
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (value === null || value === undefined || value === "") return "";
          // Numbers stay numeric so Excel can sort and filter on them; the
          // distance and the metric are the columns that matters for.
          if (isNumeric(value)) {
            return `<c r="${ref}"><v>${encodeXml(String(value).trim())}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${encodeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join("");

  const encoder = new TextEncoder();
  const part = (name, xml) => ({ name, data: encoder.encode(xml) });

  return zip([
    part("[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`),
    part("_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`),
    part("xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${encodeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
      `</workbook>`),
    part("xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`),
    part("xl/worksheets/sheet1.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${body}</sheetData></worksheet>`),
  ]);
}
