// Minimal RFC4180-ish CSV, enough for Excel exports: quoted fields, doubled
// quotes inside them, CRLF or LF, and a leading BOM that Excel likes to add.

export function parseCsv(text, delimiter = ",") {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/**
 * Guess the delimiter from the first line. A tab wins outright — that is what a
 * range copied out of Excel arrives as. Otherwise ";" vs "," , since German
 * locales export semicolons.
 */
export function sniffDelimiter(text) {
  const head = text.split(/\r?\n/)[0] ?? "";
  if (head.includes("\t")) return "\t";
  return head.split(";").length > head.split(",").length ? ";" : ",";
}

export function toCsv(rows, delimiter = ",") {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /["\n\r]|^\s|\s$/.test(s) || s.includes(delimiter)
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  return rows.map((r) => r.map(esc).join(delimiter)).join("\r\n") + "\r\n";
}
