// Browser front end. Imports the same modules the CLI uses — nothing is sent
// anywhere, the matching runs in this tab.

import { parseCsv, sniffDelimiter, toCsv } from "../src/csv.js";
import { readXlsx, writeXlsx } from "../src/xlsx.js";
import { matchAll, assignOneToOne, exportColumns, exportRow } from "../src/match.js";
import { align } from "../src/align.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const lists = {
  A: { grid: null, sheets: null, sheetIndex: 0, nameCol: 0, idCol: 1, header: true },
  B: { grid: null, sheets: null, sheetIndex: 0, nameCol: 0, idCol: 1, header: true },
};

let matched = null;         // [{ a, candidates }]
let decisions = new Map();  // a.index -> { choice: number|null, status }
let current = 0;            // index into `matched`: the row in the review card


// ---------------------------------------------------------------- input

function ingest(key, text) {
  lists[key].sheets = null;
  $(`[data-sheet-wrap]`, $(`[data-cols="${key}"]`)).hidden = true;
  setGrid(key, parseCsv(text, sniffDelimiter(text)));
}

/** Excel workbook: keep every sheet, offer a picker when there is more than one. */
async function ingestWorkbook(key, buffer) {
  const sheets = await readXlsx(buffer);
  lists[key].sheets = sheets;
  lists[key].sheetIndex = 0;

  const wrap = $(`[data-sheet-wrap]`, $(`[data-cols="${key}"]`));
  const select = $("[data-sheet]", wrap);
  select.innerHTML = "";
  sheets.forEach((sheet, i) => select.append(new Option(sheet.name, String(i))));
  select.value = "0";
  wrap.hidden = sheets.length < 2;

  setGrid(key, sheets[0].grid);
}

async function ingestFile(key, file) {
  try {
    if (/\.xls[xm]$/i.test(file.name)) await ingestWorkbook(key, await file.arrayBuffer());
    else ingest(key, await file.text());
  } catch (err) {
    alert(`Could not read ${file.name}: ${err.message}`);
  }
}

function setGrid(key, rawGrid) {
  const grid = rawGrid.filter((r) => r.some((c) => String(c).trim() !== ""));
  if (grid.length === 0) return;

  lists[key].grid = grid;
  const cols = $(`[data-cols="${key}"]`);
  cols.hidden = false;

  const width = Math.max(...grid.map((r) => r.length));
  // Only the column pickers — the sheet picker lives in the same row and must
  // keep its own options.
  for (const select of $$("select[data-col]", cols)) {
    const which = select.dataset.col;
    select.innerHTML = "";
    if (which === "id") select.append(new Option("— none —", "-1"));
    for (let c = 0; c < width; c++) {
      const label = lists[key].header && grid[0][c] ? grid[0][c] : `Column ${c + 1}`;
      select.append(new Option(label, String(c)));
    }
    select.value = String(which === "name" ? 0 : Math.min(1, width - 1));
  }
  syncColumns(key);
}

function syncColumns(key) {
  const cols = $(`[data-cols="${key}"]`);
  const sheetSelect = $("[data-sheet]", cols);
  if (lists[key].sheets && sheetSelect.value !== "") {
    const wanted = Number(sheetSelect.value);
    if (wanted !== lists[key].sheetIndex) {
      lists[key].sheetIndex = wanted;
      setGrid(key, lists[key].sheets[wanted].grid);
      return;
    }
  }
  lists[key].header = $("[data-header]", cols).checked;
  lists[key].nameCol = Number($('[data-col="name"]', cols).value);
  lists[key].idCol = Number($('[data-col="id"]', cols).value);

  const rows = rowsOf(key);
  const note = $(`[data-loaded="${key}"]`);
  note.hidden = false;
  note.textContent = `${rows.length} name${rows.length === 1 ? "" : "s"} loaded`;
  $("#run").disabled = !(rowsOf("A").length && rowsOf("B").length);
}

function rowsOf(key) {
  const cfg = lists[key];
  if (!cfg.grid) return [];
  const body = cfg.header ? cfg.grid.slice(1) : cfg.grid;
  const width = headersOf(key).length;
  return body
    .map((r, i) => ({
      name: String(r[cfg.nameCol] ?? "").trim(),
      id: cfg.idCol >= 0 ? String(r[cfg.idCol] ?? "").trim() : "",
      index: i,
      // The whole source row travels with the name, so the export can hand back
      // the user's own columns rather than just the two we matched on.
      source: Array.from({ length: width }, (_, c) => String(r[c] ?? "")),
    }))
    .filter((r) => r.name !== "");
}

/** Column headings of a loaded list, falling back to "Column n". */
function headersOf(key) {
  const cfg = lists[key];
  if (!cfg.grid) return [];
  const width = Math.max(...cfg.grid.map((r) => r.length));
  return Array.from({ length: width }, (_, c) =>
    (cfg.header && String(cfg.grid[0][c] ?? "").trim()) || `Column ${c + 1}`);
}

// ---------------------------------------------------------------- matching

function run() {
  const minMetric = Number($("#opt-min").value) / 100;
  const maxDistance = Number($("#opt-maxdist").value);
  const topN = Number($("#opt-top").value);

  matched = matchAll(rowsOf("A"), rowsOf("B"), {
    topN,
    minMetric,
    maxDistance: Number.isFinite(maxDistance) ? maxDistance : Infinity,
  });

  if ($("#opt-one").checked) {
    // Keep the shape of `matched`, but let only the winning pair survive.
    const { assigned } = assignOneToOne(matched);
    const keep = new Map(assigned.map((p) => [p.a.index, p.b.index]));
    matched = matched.map((m) => ({
      a: m.a,
      candidates: keep.has(m.a.index)
        ? m.candidates.filter((c) => c.b.index === keep.get(m.a.index))
        : [],
    }));
  }

  decisions = new Map();
  for (const m of matched) {
    const top = m.candidates[0];
    decisions.set(m.a.index, {
      choice: top ? 0 : null,
      // An exact match after cleaning needs no human; everything else does.
      status: !top ? "none" : top.exact ? "accepted" : "pending",
    });
  }

  current = nextPending(0) ?? 0;

  $("#results").hidden = false;
  renderAll();
  if (matched.length) $("#review").focus();
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderTiles();
  renderReview();
  renderTable();
}

function counts() {
  let accepted = 0, pending = 0, rejected = 0, none = 0;
  for (const d of decisions.values()) {
    if (d.status === "accepted") accepted++;
    else if (d.status === "pending") pending++;
    else if (d.status === "rejected") rejected++;
    else none++;
  }
  return { accepted, pending, rejected, none };
}

function renderTiles() {
  const c = counts();
  $("#tiles").innerHTML = [
    tile("ok", c.accepted, "confirmed"),
    tile("warn", c.pending, "to review"),
    tile("bad", c.none + c.rejected, "no match"),
    tile("", matched.length, "names in list A"),
  ].join("");
}

const tile = (cls, n, label) =>
  `<div class="tile ${cls}"><b>${n}</b><span>${label}</span></div>`;

function renderCleaned(parts) {
  return parts
    .map((p) => (p.match ? esc(p.ch) : `<i>${esc(p.ch)}</i>`))
    .join("");
}

function statusOf(index) {
  return decisions.get(matched[index].a.index).status;
}

/** Next row still needing a decision, wrapping; null when there are none left. */
function nextPending(from) {
  for (let n = 0; n < matched.length; n++) {
    const i = (from + n) % matched.length;
    if (statusOf(i) === "pending") return i;
  }
  return null;
}

function select(index) {
  current = Math.max(0, Math.min(index, matched.length - 1));
  renderAll();
}

function renderReview() {
  const wrap = $("#review-wrap");
  const box = $("#review");
  if (!matched.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const m = matched[current];
  const d = decisions.get(m.a.index);
  const left = counts().pending;

  const heading = `
    <div class="progress">
      <span>${left ? `${left} still to review` : "everything decided"} &middot; row ${current + 1} of ${matched.length}</span>
      <span><kbd>Y</kbd> keep &middot; <kbd>N</kbd> discard &middot; <kbd>1</kbd>–<kbd>9</kbd> pick another &middot; <kbd>←</kbd><kbd>→</kbd> move</span>
    </div>`;

  // A row with nothing to decide still gets shown, so clicking it in the table
  // explains itself rather than doing nothing.
  if (!m.candidates.length) {
    box.innerHTML = `${heading}
      <div class="pair">
        <div class="side">
          <div class="label">List A</div>
          <div class="name">${esc(m.a.name)}</div>
          <div class="id">${esc(m.a.id) || "&nbsp;"}</div>
          <div class="cleaned">${esc(m.a.cleaned) || "<i>nothing left after cleaning</i>"}</div>
        </div>
        <div class="side b">
          <div class="label">List B</div>
          <div class="name muted">No candidate</div>
          <div class="id">&nbsp;</div>
        </div>
      </div>
      <p class="muted" style="margin:12px 0 0">
        ${m.a.cleaned
          ? "Nothing in list B is close enough under the current settings. Loosen “Minimum match” or the character limits and match again."
          : "This name contains no letters or digits, so there is nothing to compare."}
      </p>`;
    return;
  }

  const cand = m.candidates[d.choice ?? 0];
  const a = align(m.a.cleaned, cand.b.cleaned);
  const decided =
    d.status === "accepted" ? '<span class="pill ok">confirmed</span>'
    : d.status === "rejected" ? '<span class="pill bad">discarded</span>'
    : "";

  box.innerHTML = `${heading}
    <div class="pair">
      <div class="side">
        <div class="label">List A</div>
        <div class="name">${esc(m.a.name)}</div>
        <div class="id">${esc(m.a.id) || "&nbsp;"}</div>
        <div class="cleaned">${renderCleaned(a.a)}</div>
      </div>
      <div class="side b">
        <div class="label">List B</div>
        <div class="name">${esc(cand.b.name)}</div>
        <div class="id">${esc(cand.b.id) || "&nbsp;"}</div>
        <div class="cleaned">${renderCleaned(a.b)}</div>
      </div>
    </div>
    <div class="scores">
      <div class="score"><b>${(cand.metric * 100).toFixed(1)}%</b><span>match</span></div>
      <div class="score"><b>${cand.distance}</b><span>different characters</span></div>
      ${decided}
    </div>
    <div class="actions">
      <button class="accept" data-act="accept">Keep this match</button>
      <button class="reject" data-act="reject">No match</button>
      <button class="ghost" data-act="skip">Skip</button>
    </div>
    ${renderAlternatives(m, d)}
  `;

  for (const b of $$("[data-act]", box)) b.onclick = () => act(b.dataset.act);
  for (const b of $$("[data-alt]", box)) {
    b.onclick = () => { d.choice = Number(b.dataset.alt); renderAll(); };
  }
}

function renderAlternatives(m, d) {
  if (m.candidates.length < 2) return "";
  const rows = m.candidates
    .map((c, i) => {
      const chosen = i === (d.choice ?? 0);
      return `<div>
        <kbd>${i + 1}</kbd>
        <button data-alt="${i}"${chosen ? " disabled" : ""}>${chosen ? "shown" : "show"}</button>
        <span>${esc(c.b.name)}</span>
        <span class="muted">${(c.metric * 100).toFixed(1)}% &middot; ${c.distance} chars</span>
      </div>`;
    })
    .join("");
  return `<div class="alts"><div class="muted" style="font-size:12px;margin-bottom:4px">Other candidates</div>${rows}</div>`;
}

function act(kind) {
  const d = decisions.get(matched[current].a.index);
  // The chosen candidate is kept on a discard too, so coming back to the row
  // shows what was rejected rather than an empty card.
  if (kind === "accept") d.status = "accepted";
  else if (kind === "reject") d.status = "rejected";

  const next = nextPending(current + 1);
  if (next !== null) current = next;
  renderAll();
}

function move(step) {
  if (!matched.length) return;
  current = (current + step + matched.length) % matched.length;
  renderAll();
}


function resultRows() {
  return matched.map((m) => {
    const d = decisions.get(m.a.index);
    const c = d.choice !== null && d.status !== "rejected" ? m.candidates[d.choice] : null;
    return {
      a: m.a,
      c,
      status: d.status,
    };
  });
}

function renderTable() {
  const rows = resultRows();
  const head = `<tr>
    <th>Name 1</th><th>ID 1</th><th>Name 2</th><th>ID 2</th>
    <th>Chars</th><th>Match</th><th>Status</th></tr>`;
  const body = rows
    .map(({ a, c, status }, i) => {
      const pill =
        status === "accepted" ? '<span class="pill ok">confirmed</span>'
        : status === "pending" ? '<span class="pill warn">to review</span>'
        : '<span class="pill bad">no match</span>';
      return `<tr data-row="${i}"${i === current ? ' class="selected"' : ""} title="Click to review this row">
        <td>${esc(a.name)}</td>
        <td class="muted">${esc(a.id)}</td>
        <td>${c ? esc(c.b.name) : '<span class="muted">—</span>'}</td>
        <td class="muted">${c ? esc(c.b.id) : ""}</td>
        <td class="num">${c ? c.distance : ""}</td>
        <td class="num">${c ? (c.metric * 100).toFixed(1) + "%" : ""}</td>
        <td>${pill}</td>
      </tr>`;
    })
    .join("");
  const table = $("#table");
  table.innerHTML = head + body;
  for (const tr of $$("tr[data-row]", table)) {
    tr.onclick = () => {
      select(Number(tr.dataset.row));
      $("#review").focus({ preventScroll: true });
      $("#review").scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
  }
  $("#export-note").textContent = `${rows.length} rows`;
}

/**
 * Every column of the matched pair, not just the two names.
 *
 * Someone matching a real vendor master has ten other columns in that file and
 * wants them back next to the match — otherwise the export has to be VLOOKUPed
 * against the original, which is the problem this tool exists to remove.
 *
 * Layout: the whole list A row, the whole matched list B row, then the scores.
 * Headings are prefixed so two columns both called "Name" stay distinguishable.
 */
function exportGrid() {
  const widthB = headersOf("B").length;
  return [
    exportColumns(headersOf("A"), headersOf("B")),
    ...resultRows().map(({ a, c, status }) => exportRow(a, c, widthB, status)),
  ];
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  // Semicolons and a BOM so a double-click opens cleanly in a German Excel.
  download(
    new Blob(["\uFEFF" + toCsv(exportGrid(), ";")], { type: "text/csv;charset=utf-8" }),
    "matches.csv",
  );
}

async function exportXlsx() {
  const bytes = await writeXlsx(exportGrid(), "Matches");
  download(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "matches.xlsx",
  );
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- wiring

let pendingDrop = null;
const fileInput = $("#file-input");

for (const key of ["A", "B"]) {
  const zone = $(`[data-drop="${key}"]`);
  zone.onclick = () => { pendingDrop = key; fileInput.click(); };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
  zone.ondragleave = () => zone.classList.remove("over");
  zone.ondrop = async (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (file) await ingestFile(key, file);
  };

  const area = $(`[data-paste="${key}"]`);
  area.oninput = () => { if (area.value.trim()) ingest(key, area.value); };

  // Changing the name/ID column or the header flag only re-reads the same grid.
  $(`[data-cols="${key}"]`).onchange = () => syncColumns(key);
}

fileInput.onchange = async () => {
  const file = fileInput.files[0];
  if (file && pendingDrop) await ingestFile(pendingDrop, file);
  fileInput.value = "";
};

/**
 * Back to a blank page: both lists, both previews, the result and every
 * decision. Deliberately not a page reload — a reload would also bring the
 * tutorial back for someone who has dismissed it.
 */
function reset() {
  for (const key of ["A", "B"]) {
    Object.assign(lists[key], {
      grid: null, sheets: null, sheetIndex: 0, nameCol: 0, idCol: 1, header: true,
    });
    $(`[data-paste="${key}"]`).value = "";
    $(`[data-cols="${key}"]`).hidden = true;
    $(`[data-sheet-wrap]`, $(`[data-cols="${key}"]`)).hidden = true;
    $(`[data-header]`, $(`[data-cols="${key}"]`)).checked = true;
    const note = $(`[data-loaded="${key}"]`);
    note.hidden = true;
    note.textContent = "";
  }
  matched = null;
  decisions = new Map();
  current = 0;
  $("#results").hidden = true;
  $("#review-wrap").hidden = true;
  $("#table").innerHTML = "";
  $("#run").disabled = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// The tutorial is shown until it is dismissed, then stays gone on this browser.
// Storage can be unavailable (private windows, blocked site data), so every
// access is guarded and the page simply shows the tutorial if it cannot tell.
const TUTORIAL_KEY = "matchtool.tutorial.hidden";

function showTutorial(visible) {
  $("#tutorial").hidden = !visible;
  $("#tutorial-open").hidden = visible;
  try {
    if (visible) localStorage.removeItem(TUTORIAL_KEY);
    else localStorage.setItem(TUTORIAL_KEY, "1");
  } catch { /* not worth telling the user about */ }
}

try {
  if (localStorage.getItem(TUTORIAL_KEY) === "1") showTutorial(false);
} catch { /* leave it visible */ }

$("#tutorial-close").onclick = () => showTutorial(false);
$("#tutorial-open").onclick = () => {
  showTutorial(true);
  $("#tutorial").scrollIntoView({ block: "nearest", behavior: "smooth" });
};

$("#reset").onclick = reset;
$("#run").onclick = run;
$("#export").onclick = exportCsv;
$("#export-xlsx").onclick = exportXlsx;

$("#review").onkeydown = (e) => {
  if (!matched) return;
  const k = e.key.toLowerCase();
  if (!matched.length || !matched[current].candidates.length) {
    if (k === "arrowright") { move(1); e.preventDefault(); }
    else if (k === "arrowleft") { move(-1); e.preventDefault(); }
    return;
  }
  if (k === "y" || k === "j" || k === "enter") { act("accept"); e.preventDefault(); }
  else if (k === "n") { act("reject"); e.preventDefault(); }
  else if (k === "arrowright") { move(1); e.preventDefault(); }
  else if (k === "arrowleft") { move(-1); e.preventDefault(); }
  else if (/^[1-9]$/.test(k)) {
    const m = matched[current];
    const i = Number(k) - 1;
    if (m && m.candidates[i]) {
      decisions.get(m.a.index).choice = i;
      renderAll();
      e.preventDefault();
    }
  }
};
