# Fast Venue Rank for Google Scholar

Browser extension (Chrome ≥ 121, Firefox ≥ 121) that shows, next to every Google Scholar result:

- **SJR** best quartile (Q1–Q4) for journals – SCImago Journal Rank
- **CORE / ICORE** rank (A*, A, B, C) for conferences
- **Workshop @ CVPR A\*** (outlined badge) for workshop papers: the host conference and its CORE rank,
  or just **Workshop** when the host cannot be identified. CORE ranks main tracks only, so a workshop
  paper never gets the host's rank as if it were a main-track paper.
- every other ranking of the original extension, each toggleable in the options:

| Badge | Ranking | Edition / source |
|---|---|---|
| `CCF A` | China Computer Federation list (journals + conferences) | 2022 list via [CCFrank4dblp](https://github.com/WenyanLiu/CCFrank4dblp) |
| `ABDC A*` | ABDC Journal Quality List | 2025, official xlsx |
| `VHB A+` | VHB-Rating, best of the area ratings (areas in the tooltip) | 2024, official area-rating PDFs |
| `AJG 4*` | CABS Academic Journal Guide | 2021, from Rapid-Journal-Quality-Check |
| `FNEGE 1*` | FNEGE | from Rapid-Journal-Quality-Check |
| `HCERES A` | HCERES economics & management | 2020, from Rapid-Journal-Quality-Check |
| `CNRS 1` | CNRS section 37 | from Rapid-Journal-Quality-Check |
| `BFI 2` | Danish Bibliometric Research Indicator level | from Rapid-Journal-Quality-Check |
| `FT50` | Financial Times research rank | 50 journals |
| `CORE J A*` | legacy CORE journal ranking (CORE2020 / ERA2010) | portal.core.edu.au export |
| *your label* | custom list imported in the options (CSV / JSON) | – |

  AJG, FNEGE, HCERES, CNRS and BFI have no machine-readable public source (AJG needs a login, the others
  are PDFs), so their tables are taken from the original extension's data at a pinned commit. Colours
  follow each list's own scale (best = dark green).

Rewrite of [Rapid-Journal-Quality-Check](https://github.com/JuRaKlWi/Rapid-Journal-Quality-Check), built so that every result **always settles** (badge, `N/A`, or a retryable `!`) instead of hanging.
**All rankings are local tables** — the network is only used to identify a paper's venue (at most one
Semantic Scholar and one Crossref request per paper, throttled and cached), so adding rankings adds no
requests and cannot trigger rate limits or bot checks.

## How a result is resolved

1. **Local tables** (no network): the venue string printed by Scholar is normalised and matched against the bundled SJR journal list (by name) and the ICORE conference list (by name or embedded acronym such as `CHI`, `ECCV`). Truncated venues (`…`) are only accepted when the prefix is unambiguous.
2. **Semantic Scholar** `paper/search/match` on the title → venue type, ISSN, acronyms (`NeurIPS`, `CVPR`, …), dblp key. The returned title must match the Scholar title.
3. **Crossref** `works?query.bibliographic=` as a fallback → ISSN / container title / event acronym.
4. **Other lists**: from the identifiers collected above — journal ISSNs (all ISSNs of the SJR entry
   included), exact journal names, the dblp key (`conf/cvpr/…` → CCF), and conference acronyms confirmed
   by title similarity. Proceedings-series ISSNs (LNCS, PMLR) are ignored for conference papers. Lists are
   looked up again on every cache read, so an updated table or a newly imported custom list applies to
   cached results too. Workshop papers get no list ranks.

**Workshops.** A venue string containing *workshop(s)* (Scholar line, Semantic Scholar `venue`, Crossref
`event` / `container-title`, dblp keys such as `conf/iccvw/`, acronyms such as `CVPRW`) marks the paper
as a workshop paper. The host is taken from the title in front of a trailing *Workshops* ("… Conference
on Computer Vision and Pattern Recognition Workshops" → CVPR, "Computer Vision – ECCV 2018 Workshops" →
ECCV) or from an explicit acronym ("NeurIPS 2023 Workshop on …", "… co-located with IJCAI 2021",
"(ICDMW)"); only exact title / acronym matches are accepted, so "Workshop on Machine Learning" stays a
plain *Workshop*. Workshop *series* that CORE ranks in their own right (WACV, ITW, DAS, PEPM …) are
matched as conferences as before. Known gap: Scholar often prints the main-conference name for workshop
papers ("Proceedings of the IEEE/CVF conference on computer vision and pattern recognition"); those match
the local table and are shown as main-track papers without an API check.

Requests are serialised per host with a minimum gap, retried on `429`/`5xx` (honouring `Retry-After`), aborted after 8 s, and cached in `storage.local` (60 days for hits, 7 days for misses). The content script gives up after 40 s and renders a retryable badge no matter what.

dblp is no longer used: its API sits behind an Anubis bot check and returns HTML to extensions.

## Install (unpacked)

Chrome / Chromium: `chrome://extensions` → Developer mode → *Load unpacked* → this folder.
(Chrome prints a harmless warning about the Firefox-only `browser_specific_settings` key.)
Firefox: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `manifest.json`. Then open the extension options and click *Grant access* (Firefox MV3 host permissions are opt-in).

Options (toolbar icon): toggle each ranking, import a custom ranking (CSV / JSON, same formats as the original extension), optional Crossref e-mail (polite pool), optional Semantic Scholar API key, clear cache.

## Ranking table updates

The tables are rebuilt on the 1st of every month by the GitHub Actions workflow
[`update-catalog.yml`](.github/workflows/update-catalog.yml) and published on the `catalog` branch
(`index.json` + `sjr.json`, `core.json`, `lists.json`; single force-pushed commit, so the repository does
not grow). The extension checks `index.json` once a week (`alarms`), downloads only tables whose hash
changed, verifies size + SHA-256, validates the structure, and stores them in IndexedDB. A download is
used only when it is newer than the tables bundled with the installed version; anything broken falls back
to the bundled tables. Cached lookups are cleared after an update. Options → *Catalog updates* shows where
each table comes from, has a *Check for updates now* button, an on/off switch, and a URL override (for forks).

In the workflow, a source that fails or returns less than half of its previous rows keeps the previous
data and is reported as a warning on the run (and in `index.json` → `warnings`); the node tests must pass
before anything is published. Run it by hand from the Actions tab (*Run workflow*, optionally *force*).

Setup: the repository must be public (the extension downloads anonymously), and `Catalog.DEFAULT_URL` in
[`lib/catalog.js`](lib/catalog.js) must point at `https://raw.githubusercontent.com/<owner>/<repo>/catalog/`.
Run the workflow once by hand to create the branch.

## Refresh the ranking tables locally

```
uv run scripts/build_data.py            # newest ICORE export + SJR latest edition + other lists
uv run scripts/build_data.py --core-source CORE2023
uv run scripts/build_data.py --skip-core --skip-sjr   # only data/lists.json
```

A source that fails to download keeps its previous data (warning); the other tables are still written.
`data/index.json` (hashes + build dates) is regenerated on every run and must be bundled with the extension.

- CORE: exported from <https://portal.core.edu.au/conf-ranks/>.
- SJR: scimagojr.com is behind Cloudflare, so the script reads the latest edition from the
  [ikashnitsky/sjrdata](https://github.com/ikashnitsky/sjrdata) mirror. To use the official
  export instead, download <https://www.scimagojr.com/journalrank.php?out=xls> in a browser,
  save it as `data/scimagojr.csv`, and rerun the script (the local file takes precedence).

Reload the extension afterwards.

## Tests

```
node --test tests/*.test.js          # normalisation + matcher fixtures (offline)
node scripts/smoke_resolve.js        # background resolver in node against the live APIs
node scripts/e2e_chromium.js         # headless Chromium: loads the extension, opens Scholar, checks every row settles
uv run scripts/e2e_firefox.py        # same in headless Firefox (Selenium)
node scripts/e2e_catalog.js          # catalog updater against fake local catalogs (newer / corrupted / older / missing)
```

Both e2e scripts accept a Scholar query or a full Scholar URL (e.g. an author profile) as argument.

## Layout

```
manifest.json            MV3 (Chrome uses background.service_worker, Firefox uses background.scripts)
background.js            resolver, per-host request queue, cache
lib/normalize.js         text normalisation, similarity, Scholar meta-line parser
lib/rankings.js          ranking tables and lookups (ISSN / name / acronym / dblp key / fuzzy / prefix)
lib/customlist.js        CSV / JSON parser for the custom ranking import
lib/catalog.js           catalog update: index / table validation, checksums, IndexedDB store
.github/workflows/       monthly table rebuild -> `catalog` branch
content/scholar.js       Scholar DOM parsing and badge rendering (search results + author profiles)
options.html/js          settings page
data/sjr.json, core.json, lists.json, index.json   bundled tables + their hashes (generated)
scripts/build_data.py    table builder
```

## Licence

MIT. Ranking data belongs to its publishers (SCImago, CORE/ICORE, CCF, ABDC, VHB, Chartered ABS, FNEGE, HCERES, CNRS, the Danish Ministry of Higher Education and Science, Financial Times).
