# matchtool

Match two lists of names that are the same thing spelled differently — umlauts,
typos, abbreviations, legal forms, truncation. A port of the VBA original, with
its cleaning rules, its metric and its ranking preserved exactly.

Plain ES modules, no dependencies and no build step, so the same files run under
Node for the CLI and in a browser for the eventual UI.

```bash
node build.js                       # -> dist/matchtool.html, one standalone file
node serve.js                       # then open http://localhost:8000
node cli.js examples/list-a.xlsx examples/list-b.xlsx --out matches.xlsx
node test/test.js
node examples/bench.js
```

## The UI

`ui/` is the page: drop a CSV into each side or paste a range straight out of
Excel, pick the name and ID columns, match. Results split three ways — confirmed
(identical after cleaning, no human needed), to review, no match.

The review card is the point of the thing. One pair at a time, the cleaned names
shown character-aligned so the differing characters are struck through, and
<kbd>Y</kbd> / <kbd>N</kbd> / <kbd>1</kbd>–<kbd>9</kbd> / <kbd>←</kbd><kbd>→</kbd>
to decide without the mouse.

**Any row in the table can be clicked** to bring it back into the card — including
ones already decided, so a mistake is one click away from being changed, and
including ones with no match at all, where the card explains why instead of doing
nothing. The card shows the current verdict as a pill, and the selected row is
marked in the table.

A short **tutorial** sits at the top on first visit. Dismissing it is remembered
per browser, and a "How it works" link brings it back. **Reset** clears both
lists, the result and every decision without reloading — a reload would bring the
tutorial back for someone who had dismissed it. Export is CSV with a BOM and semicolons, so a
double-click opens it correctly in a German Excel.

A browser refuses ES module imports over `file://`, which is the only reason
`serve.js` exists — it serves the repo root so `ui/app.js` can import `../src/*`
unchanged. Nothing is uploaded and there is no backend; the matching runs in the
tab.

## Testing it

**The automated suite** — 38 tests, offline, under a second:

```bash
node test/test.js
```

It fuzzes the bounded Levenshtein against the full matrix, checks the prefilter
never drops a qualifying pair, and diffs the metric against
`test/vba-reference.js`, a faithful transcription of the original.

**By hand**, on the demo lists:

```bash
node examples/make-demo.js
node cli.js examples/list-a.xlsx examples/list-b.xlsx --top 1 --out matches.xlsx
node serve.js            # the page, at http://localhost:8000
node build.js            # then double-click dist/matchtool.html, no server
```

**Against the VBA** — the test that actually matters, because the VBA is what
you trust:

```bash
node examples/make-parity.js
```

That writes `examples/parity.xlsx`, laid out exactly like the VBA input sheet
(headings in row 3, data from row 4, `A`/`B` = Name 1 and ID, `C`/`D` = Name 2
and ID), plus the same two lists as CSVs for this tool. Paste columns A–D into
the matcher, run `AskAndRun` with 1 result per name, copy `H3:P<last>` into a
fresh sheet, save it as CSV, then:

```bash
node test/parity.js <that-file.csv>
```

It prints the rows where the two disagree. Filters are switched off for the
comparison, since the VBA has none — this tests the algorithm, not the
thresholds added since. Two differences are expected and documented below: a
name that cleans to empty, and the dropped last group when list B is short.

The fixture covers umlauts, ß, non-German accents, case, a dropped legal form, a
written-out legal form, a doubled-letter typo, a trailing addition, a name with
no counterpart, a duplicate in list A, a two-letter name and a row that cleans
to nothing.

## The metric

```
metric = 1 - (lev - |len1 - len2|) / min(len1, len2)
```

Subtracting the length difference removes the edits forced on a pair purely
because one name is longer. What is left is the mismatch inside the part the two
names share, measured against the shorter one.

The property that makes it work on business data:

> **The metric is 1 exactly when the shorter cleaned name is a subsequence of
> the longer one.**

`lev == |Δlen|` means the pair needs insertions only, which is the definition of
a subsequence. So truncations, appended suffixes *and initialisms* all score 1 —
`GmbH` is a subsequence of `Gesellschaft mit beschränkter Haftung`, which is why
that pair matches without a single hand-written abbreviation rule.

| Pair | this metric | `1 - lev/maxLen` |
|---|---|---|
| Müller GmbH ↔ Müller Gesellschaft mit beschränkter Haftung | **100%** | 26% |
| Müller GmbH ↔ Müller Handels GmbH & Co. KG | **100%** | 50% |
| Müller GmbH ↔ Müller | **100%** | 64% |
| Schmitt Industrieanlagen ↔ Schmidt Industrieanlagen | **96%** | 96% |
| Müller GmbH ↔ Müller **AG** | **78%** | 64% |
| ABB ↔ ABC | **67%** | 67% |

Bounded to [0,1], because `lev >= |Δlen|` and `lev - |Δlen| <= minLen`.

### Two thresholds, not one

Subsequence tolerance is permissive for short names: `AG` is a subsequence of
`Müller Handels GmbH`, so it scores 100% with 16 characters of difference. The
raw distance is the second sort key and also a filter (`--max-dist`, default
**35**).

35 is chosen so a written-out legal form survives — `Müller GmbH` against
`Müller Gesellschaft mit beschränkter Haftung` is 31 characters apart. But an
absolute cap wide enough for that is also wide enough for `AG` to reach almost
any company name, so there is a second cap: **at most 3 × the length of the
shorter name** (`--max-ratio`). Whichever is tighter wins.

The factor of 3 is measured, not guessed:

| pair | edits ÷ shorter name |
|---|---|
| Hoffmann Logistik GmbH & Co. KG ↔ Hofmann Logistik | 0.6× |
| Siemens AG ↔ Siemens Energy AG | 0.7× |
| Weiß & Söhne KG ↔ Weiss & Soehne Kommanditgesellschaft | 1.5× |
| Müller GmbH ↔ Müller Gesellschaft mit beschränkter Haftung | 2.8× |
| — cut at 3.0 — | |
| AG ↔ Müller Handels GmbH | 8.0× |
| SE ↔ Thyssen Fördertechnik | 9.5× |
| KG ↔ Grünewald Pharma Gesellschaft | 13.5× |

Every legitimate expansion sits below 3, every short-name false positive well
above it.

## Excel

`.xlsx` in and out, on the command line and in the page — read a workbook (sheet
picker when it has more than one), write results as a workbook.

Implemented from scratch in `src/zip.js` and `src/xlsx.js`, about 350 lines,
because the platform already provides the hard part: `CompressionStream` and
`DecompressionStream` give deflate in every current browser and in Node 18+. No
vendored library. That keeps `dist/matchtool.html` at 56 KB rather than a
megabyte, and a tool whose pitch is "nothing leaves your computer" is easier to
believe when there is no third-party code in it at all.

Scope is narrow on purpose: cell values as text, no styles or formulas. One
detail worth keeping — a value is written as a number only if it round-trips
through `Number` exactly, so `007` stays `007`. Written as a numeric cell it
would display as `7`, silently corrupting an ID column.

## One self-contained file

`node build.js` writes two files into `dist/`, neither with a single external
reference:

- **`matchtool.html`** — the tool. Opens from a double-click, no server. This
  file *is* the on-prem version and the download.
- **`index.html`** — the German landing page, linking to it.

Deploying is uploading `dist/`. Nothing else.

The bundler is ~130 lines rather than a toolchain: walk the import graph, strip
the `import`/`export` keywords, concatenate in dependency order. It works because
every module uses distinct top-level names and there are no dependencies to
resolve. `serve.js` still exists for development, since a browser refuses ES
module imports over `file://`.

Two things it has to get right, both of which bit once:

- **Function replacers, never string ones.** `String.replace` with a string
  treats `$$` as an escaped `$`, which rewrote `const $$ = …` into a second
  `const $ = …` and made every build unparseable while the served version stayed
  fine.
- **Compile before shipping.** The build now runs its own output through
  `new vm.Script` and refuses to write a file that does not parse.

`ui/` also holds `landing.html` and `landing.css`; the landing page reuses the
app's palette from `style.css`.

## Cleaning

`Müller Handels GmbH & Co. KG` → `muellerhandelsgmbhcokg`

Lowercase → `ä/ö/ü/ß` → `ae/oe/ue/ss` → remaining accents fold to their base
letter (`é`→`e`) → everything outside `[a-z0-9]` is dropped. Umlauts must expand
before the accent fold, or `ä` would collapse to `a` and lose its `e`. Input is
normalised to NFC first so an `ä` typed as `a` + combining diaeresis is handled
the same as a precomposed one.

Legal forms are deliberately **not** stripped — the metric already tolerates
them, and keeping them lets `# Different Chars` show how far apart the two names
really are.

## Speed

The VBA wrote every pair into a worksheet, and called
`Application.WorksheetFunction.Min` once per matrix cell — a COM round-trip per
character pair. Here each pair is pruned or bounded before any matrix work:

1. **Character-count bound.** Characters of the shorter name absent from the
   longer one each cost at least one edit beyond the length difference, so a pair
   with too many is dropped without running Levenshtein. Exact, never drops a
   qualifying pair (there is a test for that).
2. **Bounded Levenshtein.** Solving `metric >= t` for `lev` gives the exact
   cutoff `k = |Δlen| + (1-t)·minLen` per pair. Only the diagonal band
   `|i-j| <= k` is computed, and a row entirely above `k` aborts.
3. **Memoised by cleaned name**, so duplicates in the first list cost nothing.

The usual "skip pairs whose lengths differ by more than k" filter is deliberately
absent: tolerating length differences is the point of this metric, so that filter
would silently discard correct matches.

```
  500 x 500   =     250000 pairs       46 ms
 1000 x 1000  =    1000000 pairs      170 ms
 2000 x 2000  =    4000000 pairs      894 ms
 4000 x 4000  =   16000000 pairs     2086 ms
```

## One-to-one assignment

`--one-to-one`. Taking each row's own best candidate lets several names claim the
same counterpart, which is wrong for reconciliation — one invoice is one booking.
Instead every candidate pair competes globally: strongest first, each side used
once, the rest reported as unmatched.

## Deliberate divergences from the VBA

`test/vba-reference.js` transcribes the original faithfully, bugs included, and
the suite asserts the port agrees with it everywhere except here:

| | VBA | here |
|---|---|---|
| Empty cleaned name | scored `1` — a perfect match against everything, floating blank and junk rows to the top of every group | scores `0`, matches nothing |
| Second list shorter than 5 rows | last `Name 1` group silently dropped (`lastRow - firstRow` bound in `SelectOnlyTheBestMatch` only works for `stepSize >= 5`) | all groups returned |
| `n` greater than the second list's length | results written back into `H:P` overrun rows not yet read | no shared buffer, capped at the number of candidates |
| Non-German accents (`é`, `ñ`, `ç`) | deleted, so `José` → `jos` | folded, so `José` → `jose` |

## Layout

```
src/normalize.js    cleaning, character histogram, prefilter bound
src/levenshtein.js  reference + bounded implementations
src/metric.js       the metric, its exact cutoff, the ranking comparator
src/match.js        n x m matching, one-to-one assignment
src/csv.js          CSV in/out, sniffs , vs ; vs tab
src/zip.js          ZIP via the platform's deflate, no dependencies
src/xlsx.js         .xlsx read/write on top of it
cli.js              command line
build.js            bundles everything into dist/matchtool.html
serve.js            static server for the UI (module imports need an origin)
ui/                 the app, plus landing.html and landing.css
dist/               built output: matchtool.html + index.html
test/               39 tests, incl. fuzzing against the VBA reference
test/parity.js      diffs this port against your VBA's own output
examples/           demo lists, the VBA parity fixture, benchmark
```

## Next

- Carry the workbook's other columns through to the output, not just name and ID.
- An Excel add-in (Office.js) — reads the selected range and writes results back
  into the sheet, and ships through a store rather than as a file.
- Saved rule sets per recurring job.
