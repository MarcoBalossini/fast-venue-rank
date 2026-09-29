#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=15", "requests>=2.31", "openpyxl>=3.1", "pdfplumber>=0.11"]
# ///
"""Build data/sjr.json, data/core.json and data/lists.json.

CORE : ICORE/CORE conference ranking, exported as CSV from portal.core.edu.au.
SJR  : SCImago Journal Rank. scimagojr.com sits behind Cloudflare, so by default the
       latest edition is taken from the community mirror ikashnitsky/sjrdata (parquet).
       If data/scimagojr.csv exists (manual download of journalrank.php?out=xls), it wins.
LISTS: the other rankings of Rapid-Journal-Quality-Check, matched locally by ISSN / name / dblp key:
       ABDC (abdc.edu.au xlsx), VHB-Rating 2024 (vhbonline.org area-rating PDFs), CCF (CCFrank4dblp),
       CORE journals (portal.core.edu.au), FT50, and AJG / FNEGE / HCERES / CNRS / BFI as bundled by
       Rapid-Journal-Quality-Check (no machine-readable public source).

Unattended runs (GitHub Actions, monthly): a source that fails, or returns less than half of the
previous table, keeps its previous data and is reported as a warning. data/index.json lists each
table's hash for the extension's catalog updater.

Usage:
  uv run scripts/build_data.py [--core-source ICORE2026] [--sjr-csv data/scimagojr.csv] [--skip-lists]
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "fast-venue-rank-build/1.0 (+https://github.com/)"

CORE_PORTAL = "https://portal.core.edu.au/conf-ranks/"
SJR_MIRROR_API = "https://api.github.com/repos/ikashnitsky/sjrdata/contents/data-raw/sjr-journal"
SJR_MIRROR_RAW = "https://raw.githubusercontent.com/ikashnitsky/sjrdata/master/data-raw/sjr-journal/"

MAIN_RANKS = {"A*", "A", "B", "C"}
DATA_SCHEMA = 1        # bump on incompatible changes of the JSON layout; the extension ignores other schemas
TABLES = ("sjr", "core", "lists")
SHRINK_LIMIT = 0.5     # a table that drops below half its previous size is treated as a broken source

WARNINGS = []


def log(msg):
    print(msg, file=sys.stderr)


def warn(msg):
    WARNINGS.append(msg)
    log(f"  WARNING: {msg}")
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::warning::{msg}", flush=True)


def load_previous(name):
    path = DATA / f"{name}.json"
    try:
        return json.loads(path.read_text()) if path.exists() else None
    except (OSError, ValueError):
        return None


def write_table(name, out, count, previous_count):
    """Write data/<name>.json unless the new table is suspiciously small compared with the previous one."""
    if previous_count and count < previous_count * SHRINK_LIMIT:
        warn(f"{name}.json: only {count} rows (previously {previous_count}); keeping the previous table")
        return False
    (DATA / f"{name}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    return True


def get(url, **kw):
    headers = {"User-Agent": UA}
    # Anonymous GitHub API calls from shared CI runners hit the 60/h limit quickly.
    if url.startswith("https://api.github.com/") and os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    r = requests.get(url, headers=headers, timeout=120, **kw)
    r.raise_for_status()
    return r


# ---------------------------------------------------------------- CORE

def detect_core_source():
    """Return the newest ranking source offered by the portal (e.g. ICORE2026)."""
    try:
        html = get(CORE_PORTAL).text
    except Exception as e:  # noqa: BLE001
        log(f"  portal page fetch failed ({e}); falling back to ICORE2026")
        return "ICORE2026"
    opts = re.findall(r"<option[^>]*>\s*((?:I?CORE|ERA)\d{4})\s*<", html)
    if not opts:
        return "ICORE2026"
    return opts[0]


def build_core(source):
    url = f"{CORE_PORTAL}?search=&by=all&source={source}&sort=atitle&page=1&do=Export"
    text = get(url).text
    rows = list(csv.reader(io.StringIO(text)))
    confs = []
    for r in rows:
        if len(r) < 5:
            continue
        title = r[1].strip()
        acro = r[2].strip()
        raw_rank = r[4].strip()
        if not title:
            continue
        rank = raw_rank if raw_rank in MAIN_RANKS else "other"
        confs.append([title, acro, rank, raw_rank])
    confs.sort(key=lambda x: x[0].lower())
    out = {
        "source": source,
        "built": dt.date.today().isoformat(),
        "url": CORE_PORTAL,
        "confs": confs,
    }
    prev = load_previous("core")
    if write_table("core", out, len(confs), len(prev["confs"]) if prev else 0):
        log(f"  core.json: {len(confs)} conferences from {source}")


# ---------------------------------------------------------------- SJR

def norm_issn(s):
    s = re.sub(r"[^0-9Xx]", "", s or "").upper()
    return s if len(s) == 8 else None


def issn_list(field):
    out = []
    for part in re.split(r"[,;\s]+", field or ""):
        n = norm_issn(part)
        if n and n not in out:
            out.append(n)
    return out


def to_float(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if v != v else float(v)  # NaN check
    v = str(v).strip().replace(",", ".")
    try:
        return float(v)
    except ValueError:
        return None


def to_int(v):
    f = to_float(v)
    return None if f is None else int(f)


def quartile(v):
    v = (v or "").strip().upper()
    return v if v in {"Q1", "Q2", "Q3", "Q4"} else None


def build_sjr_from_csv(path):
    """Official scimagojr.com export: ';' separated, decimal comma."""
    text = Path(path).read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text), delimiter=";"))
    if not rows or "Title" not in rows[0]:
        raise SystemExit(f"{path}: not a scimagojr export (expected ';'-separated with a Title column)")
    edition = None
    for k in rows[0]:
        m = re.match(r"Total Docs\. \((\d{4})\)", k)
        if m:
            edition = int(m.group(1))
    journals = []
    for r in rows:
        journals.append([
            r["Title"].strip(),
            issn_list(r.get("Issn")),
            quartile(r.get("SJR Best Quartile")),
            to_int(r.get("H index")),
            to_float(r.get("SJR")),
            (r.get("Type") or "").strip(),
        ])
    return edition, f"scimagojr.com export ({Path(path).name})", journals


def build_sjr_from_mirror():
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    listing = get(SJR_MIRROR_API).json()
    files = sorted(
        (f["name"] for f in listing if f["name"].endswith(".parquet")),
        key=lambda n: int(re.findall(r"(\d{4})", n)[-1]),
    )
    if not files:
        raise SystemExit("mirror listing returned no parquet files")
    name = files[-1]
    log(f"  downloading {name} from mirror ...")
    blob = get(SJR_MIRROR_RAW + name).content
    table = pq.read_table(
        io.BytesIO(blob),
        columns=["year", "sourceid", "title", "type", "issn", "sjr", "sjr_best_quartile", "h_index"],
    )
    years = pc.unique(table["year"]).to_pylist()
    edition = int(max(years))
    table = table.filter(pc.equal(table["year"], float(edition)))
    seen = set()
    journals = []
    for r in table.to_pylist():
        sid = r["sourceid"]
        if sid in seen:
            continue
        seen.add(sid)
        journals.append([
            (r["title"] or "").strip(),
            issn_list(r["issn"]),
            quartile(r["sjr_best_quartile"]),
            to_int(r["h_index"]),
            to_float(r["sjr"]),
            (r["type"] or "").strip(),
        ])
    return edition, f"ikashnitsky/sjrdata mirror ({name})", journals


def build_sjr(csv_path):
    if csv_path and Path(csv_path).exists():
        log(f"  using local {csv_path}")
        edition, source, journals = build_sjr_from_csv(csv_path)
    else:
        edition, source, journals = build_sjr_from_mirror()
    journals = [j for j in journals if j[0]]
    journals.sort(key=lambda x: x[0].lower())
    out = {
        "edition": edition,
        "built": dt.date.today().isoformat(),
        "source": source,
        "journals": journals,
    }
    prev = load_previous("sjr")
    if write_table("sjr", out, len(journals), len(prev["journals"]) if prev else 0):
        log(f"  sjr.json: {len(journals)} sources, edition {edition} ({source})")


# ---------------------------------------------------------------- other rankings (lists.json)

ABDC_PAGE = "https://abdc.edu.au/abdc-journal-quality-list/"
VHB_SITE = "https://vhbonline.org"
VHB_AREAS = VHB_SITE + "/en/services/vhb-rating-2024/area-ratings"
CCF_LIST = "https://raw.githubusercontent.com/WenyanLiu/CCFrank4dblp/master/data/dataGen.js"
CORE_JNL = "https://portal.core.edu.au/jnl-ranks/?search=&by=all&source=all&sort=atitle&page=1&do=Export"
RJQC_REPO = "https://github.com/JuRaKlWi/Rapid-Journal-Quality-Check"
RJQC_COMMIT = "f11e1646f0b9a94f25735a19de4582d16bfd4e23"
RJQC_RAW = f"https://raw.githubusercontent.com/JuRaKlWi/Rapid-Journal-Quality-Check/{RJQC_COMMIT}/data/"

# Display metadata. `scale` runs best -> worst and drives the badge colour (spread over 5 tiers,
# or `tiers` = explicit tier 0-4 per scale step).
LISTS = {
    "ABDC":   {"label": "ABDC", "name": "ABDC Journal Quality List", "scale": ["A*", "A", "B", "C"], "url": ABDC_PAGE},
    "VHB":    {"label": "VHB", "name": "VHB-Rating (best area rating)", "edition": "2024", "scale": ["A+", "A", "B", "C", "D"], "url": VHB_AREAS},
    "AJG":    {"label": "AJG", "name": "CABS Academic Journal Guide", "edition": "2021", "scale": ["4*", "4", "3", "2", "1"], "url": "https://charteredabs.org/academic-journal-guide/"},
    "FNEGE":  {"label": "FNEGE", "name": "FNEGE ranking", "scale": ["1*", "1", "2", "3", "4"], "url": "https://www.fnege.org/classement-des-revues-scientifiques-en-sciences-de-gestion/"},
    "HCERES": {"label": "HCERES", "name": "HCERES economics & management list", "edition": "2020", "scale": ["A", "B", "C"], "url": "https://www.hceres.fr/"},
    "CNRS":   {"label": "CNRS", "name": "CNRS section 37 ranking", "scale": ["1", "2", "3", "4"], "url": "https://www.gate.cnrs.fr/"},
    "BFI":    {"label": "BFI", "name": "Danish Bibliometric Research Indicator (level)", "scale": ["3", "2", "1"], "tiers": [0, 1, 2], "url": "https://ufm.dk/"},
    "FT50":   {"label": "FT50", "name": "Financial Times research rank (FT50)", "scale": ["FT50"], "url": "https://www.ft.com/content/3405a512-5cbb-11e1-8f1f-00144feabdc0"},
    "CCF":    {"label": "CCF", "name": "China Computer Federation recommended list", "scale": ["A", "B", "C"], "url": "https://www.ccf.org.cn/"},
    "COREJ":  {"label": "CORE J", "name": "CORE journal ranking (legacy, CORE2020 / ERA2010)", "scale": ["A*", "A", "B", "C"], "url": "https://portal.core.edu.au/jnl-ranks/"},
}
LEGACY_NOTE = f"as bundled by Rapid-Journal-Quality-Check ({RJQC_COMMIT[:7]})"

FT50_TITLES = [
    "Academy of Management Journal", "Academy of Management Review", "Accounting Review",
    "Accounting, Organizations and Society", "Administrative Science Quarterly", "American Economic Review",
    "Contemporary Accounting Research", "Econometrica", "Entrepreneurship Theory and Practice",
    "Harvard Business Review", "Human Relations", "Human Resource Management", "Information Systems Research",
    "Journal of Accounting and Economics", "Journal of Accounting Research", "Journal of Applied Psychology",
    "Journal of Business Ethics", "Journal of Business Venturing", "Journal of Consumer Psychology",
    "Journal of Consumer Research", "Journal of Finance", "Journal of Financial and Quantitative Analysis",
    "Journal of Financial Economics", "Journal of International Business Studies", "Journal of Management",
    "Journal of Management Information Systems", "Journal of Management Studies", "Journal of Marketing",
    "Journal of Marketing Research", "Journal of Operations Management", "Journal of Political Economy",
    "Journal of the Academy of Marketing Science", "Management Science", "Manufacturing & Service Operations Management",
    "Marketing Science", "MIS Quarterly", "MIT Sloan Management Review", "Operations Research", "Organization Science",
    "Organization Studies", "Organizational Behavior and Human Decision Processes", "Production and Operations Management",
    "Quarterly Journal of Economics", "Research Policy", "Review of Accounting Studies", "Review of Economic Studies",
    "Review of Finance", "Review of Financial Studies", "Strategic Entrepreneurship Journal", "Strategic Management Journal",
]


def cell(v):
    return re.sub(r"\s+", " ", str(v if v is not None else "")).strip()


class JournalSet:
    """Journal entries merged across lists: ISSN overlap joins entries, otherwise the exact title does."""

    def __init__(self, sjr_issns=None):
        self.sjr_issns = sjr_issns or {}   # title key -> ISSNs, only for titles unique in SJR
        self.entries = []   # {"title", "issns": [], "ranks": {}, "notes": {}}
        self.by_issn = {}
        self.by_title = {}

    @staticmethod
    def title_key(t):
        t = re.sub(r"&", " and ", t.lower())
        return " ".join(w for w in re.findall(r"[a-z0-9]+", t) if w not in {"the", "of", "and"})

    def add(self, list_id, title, issns, rank, note=None):
        title, rank = cell(title), cell(rank)
        if not title or not rank or rank.upper() in {"NA", "N/A", "-"}:
            return
        issns = [i for i in (norm_issn(x) for x in issns) if i]
        # Lists often carry only the print or only the online ISSN; SJR knows both for a unique title.
        issns += [i for i in self.sjr_issns.get(self.title_key(title), []) if i not in issns]
        e = next((self.by_issn[i] for i in issns if i in self.by_issn), None)
        if e is None and not issns:
            e = self.by_title.get(self.title_key(title))
        if e is None:
            e = {"title": title, "issns": [], "ranks": {}, "notes": {}}
            self.entries.append(e)
            self.by_title.setdefault(self.title_key(title), e)
        for i in issns:
            if i not in e["issns"]:
                e["issns"].append(i)
            self.by_issn.setdefault(i, e)
        e["ranks"].setdefault(list_id, rank)
        if note:
            e["notes"].setdefault(list_id, note)

    def rows(self):
        out = []
        for e in sorted(self.entries, key=lambda x: x["title"].lower()):
            row = [e["title"], e["issns"], e["ranks"]]
            if e["notes"]:
                row.append(e["notes"])
            out.append(row)
        return out


def lists_abdc(js, meta):
    html = requests.get(ABDC_PAGE, headers={"User-Agent": "Mozilla/5.0"}, timeout=60).text
    links = re.findall(r'href="([^"]+\.xlsx)"', html)
    if not links:
        raise RuntimeError("no .xlsx link on the ABDC page")
    import openpyxl
    blob = requests.get(links[0], headers={"User-Agent": "Mozilla/5.0"}, timeout=120).content
    ws = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True).worksheets[0]
    header = None
    n = 0
    for r in ws.iter_rows(values_only=True):
        r = [cell(c) for c in r]
        if header is None:
            if "Journal Title" in r:
                header = r
                ti = r.index("Journal Title")
                rating = next(i for i, c in enumerate(r) if re.search(r"rating", c, re.I))
                issn_cols = [i for i, c in enumerate(r) if c.upper().startswith("ISSN")]
                edition = re.search(r"(\d{4})", r[rating])
                meta["edition"] = edition.group(1) if edition else ""
            continue
        rank = r[rating].replace(" ", "") if len(r) > rating else ""
        if rank in {"A*", "A", "B", "C"}:
            js.add("ABDC", r[ti], [r[i] for i in issn_cols], rank)
            n += 1
    meta["source"] = links[0].rsplit("/", 1)[-1]
    return n


VHB_LINE = re.compile(r"^(.+?)\s+(\d{4}-?\d{3}[\dXx])\s+(A\+|A|B|C|D)\s+(?:legal-normative\s+)?\d+\b")
# Scientific-quality ratings only: *_comm / *_prac* rate other criteria (practical relevance, communication).
VHB_PDF = re.compile(r"Area_rating_([A-Z]+)(?:_e_f|_r_n)?\.pdf$")
VHB_ORDER = ["A+", "A", "B", "C", "D"]


def lists_vhb(js, meta):
    import pdfplumber
    html = requests.get(VHB_AREAS, headers={"User-Agent": "Mozilla/5.0"}, timeout=60).text
    pages = sorted(set(re.findall(r'href="(/en/verband/wissenschaftliche-kommissionen/[^"]*vhb-rating-2024[^"]*)"', html)))
    if not pages:
        raise RuntimeError("no area-rating pages found")
    best = {}   # issn -> [title, rank, [area rank, ...]]
    for p in pages:
        sub = requests.get(VHB_SITE + p, headers={"User-Agent": "Mozilla/5.0"}, timeout=60).text
        for u in re.findall(r'href="([^"]+\.pdf)"', sub):
            m = VHB_PDF.search(u)
            if not m:
                continue
            area = m.group(1)
            blob = requests.get(u if u.startswith("http") else VHB_SITE + u, headers={"User-Agent": "Mozilla/5.0"}, timeout=120).content
            count = 0
            with pdfplumber.open(io.BytesIO(blob)) as pdf:
                for page in pdf.pages:
                    for line in (page.extract_text() or "").splitlines():
                        m = VHB_LINE.match(line.strip())
                        if not m:
                            continue
                        title, issn, rank = m.group(1).strip(), norm_issn(m.group(2)), m.group(3)
                        if not issn:
                            continue
                        e = best.setdefault(issn, [title, rank, []])
                        e[2].append(f"{area} {rank}")
                        if VHB_ORDER.index(rank) < VHB_ORDER.index(e[1]):
                            e[1] = rank
                        count += 1
            log(f"    VHB {area}: {count} journals")
    for issn, (title, rank, areas) in best.items():
        js.add("VHB", title, [issn], rank, "areas: " + ", ".join(sorted(set(areas))))
    meta["source"] = f"{len(pages)} area ratings"
    return len(best)


def lists_corej(js, meta):
    text = get(CORE_JNL).text
    n = 0
    for r in csv.DictReader(io.StringIO(text)):
        rank = cell(r.get("rank"))
        if rank not in {"A*", "A", "B", "C"}:
            continue
        issns = [r.get(k) for k in ("ISSN1", "ISSN2", "ISSN3", "ISSN4")]
        js.add("COREJ", r.get("title"), issns, rank, cell(r.get("source")))
        n += 1
    meta["source"] = "portal.core.edu.au export"
    return n


def lists_legacy(js, metas):
    """AJG, FNEGE, HCERES, CNRS, BFI from the tab-separated tables of Rapid-Journal-Quality-Check."""
    def rows(name):
        text = get(RJQC_RAW + name).content.decode("cp1252", errors="replace")
        for line in text.splitlines():
            m = re.match(r'\s*"(.*)\\n"\s*\+?\s*$', line)
            if m:
                yield [c.strip() for c in m.group(1).split("\t")]

    # ISSNs.txt: ISSN SJR_Q SJR_H VHB FNEGE CNRS HCERES CORE src BFI AJG JCR SNIP SJR CiteS ABDC name
    # Names.txt: key  SJR_Q SJR_H VHB FNEGE CNRS HCERES CORE src CORE_c CCF BFI AJG JCR SNIP SJR CiteS ABDC FT50 name
    cols_issn = {"FNEGE": 4, "CNRS": 5, "HCERES": 6, "BFI": 9, "AJG": 10}
    cols_name = {"FNEGE": 4, "CNRS": 5, "HCERES": 6, "BFI": 11, "AJG": 12}
    counts = {k: 0 for k in cols_issn}
    for r in rows("ISSNs.txt"):
        if len(r) < 17:
            continue
        title = r[16].lstrip("'@")
        for k, i in cols_issn.items():
            if r[i] not in ("", "NA"):
                js.add(k, title, [r[0]], r[i])
                counts[k] += 1
    for r in rows("Names.txt"):
        if len(r) < 20:
            continue
        title = r[19].lstrip("'@")
        for k, i in cols_name.items():
            if r[i] not in ("", "NA"):
                js.add(k, title, [], r[i])
    for k in cols_issn:
        metas[k]["source"] = LEGACY_NOTE
    return counts


def lists_ft50(js, meta, sjr_by_title):
    for t in FT50_TITLES:
        js.add("FT50", t, sjr_by_title.get(JournalSet.title_key(t), []), "FT50")
    meta["source"] = "FT research rank, 50 journals"
    return len(FT50_TITLES)


def lists_ccf(meta, js, sjr_by_title):
    text = get(CCF_LIST).text
    confs = []
    for m in re.finditer(r'"([ABC])\t([^\t]*)\t([^\t]+)\t(/[^\t]+)\t(/[^\t"\\]+)\\n"', text):
        rank, abbr, full, db = m.group(1), m.group(2).strip(), m.group(3).strip(), m.group(4).strip()
        confs.append([rank, abbr, full, db.lstrip("/")])
        if db.startswith("/journals/"):
            js.add("CCF", full, sjr_by_title.get(JournalSet.title_key(full), []), rank, abbr or None)
    upd = re.search(r"Last updated:\s*([\d-]+)", get(CCF_LIST.replace("dataGen.js", "ccfRankUrl.js")).text)
    meta["edition"] = "2022"
    meta["source"] = "WenyanLiu/CCFrank4dblp" + (f" (updated {upd.group(1)})" if upd else "")
    return confs


class Recorder:
    """Collects one source's rows so they can be checked before being merged into the JournalSet."""

    def __init__(self):
        self.rows = {}   # list id -> [(title, issns, rank, note)]

    def add(self, list_id, title, issns, rank, note=None):
        self.rows.setdefault(list_id, []).append((title, list(issns), rank, note))


def build_lists():
    metas = {k: dict(v) for k, v in LISTS.items()}
    sjr_titles = {}
    sjr_path = DATA / "sjr.json"
    if sjr_path.exists():
        for title, issns, *_ in json.loads(sjr_path.read_text())["journals"]:
            sjr_titles.setdefault(JournalSet.title_key(title), []).append(issns)
    sjr_by_title = {k: v[0] for k, v in sjr_titles.items() if len(v) == 1 and v[0]}

    # Previous table, per list: fallback rows for a source that fails or shrinks.
    prev = load_previous("lists") or {"lists": {}, "journals": [], "ccf": []}
    prev_rows = {}
    for row in prev["journals"]:
        title, issns, ranks = row[0], row[1], row[2]
        notes = row[3] if len(row) > 3 else {}
        for k, rank in ranks.items():
            prev_rows.setdefault(k, []).append((title, issns, rank, notes.get(k)))

    rec = Recorder()
    confs = []
    failed = set()

    def step(name, fn):
        try:
            log(f"  {name}: {fn()}")
        except Exception as e:  # noqa: BLE001 - one broken source must not kill the others
            failed.add(name)
            warn(f"{name}: source failed ({e}); keeping the previous data")

    def ccf():
        nonlocal confs
        confs = lists_ccf(metas["CCF"], rec, sjr_by_title)
        return len(confs)

    step("ABDC", lambda: lists_abdc(rec, metas["ABDC"]))
    step("VHB", lambda: lists_vhb(rec, metas["VHB"]))
    step("COREJ", lambda: lists_corej(rec, metas["COREJ"]))
    step("legacy", lambda: lists_legacy(rec, metas))
    step("FT50", lambda: lists_ft50(rec, metas["FT50"], sjr_by_title))
    step("CCF", ccf)

    if prev["ccf"] and len(confs) < len(prev["ccf"]) * SHRINK_LIMIT:
        warn(f"CCF: {len(confs)} venues (previously {len(prev['ccf'])}); keeping the previous data")
        confs = prev["ccf"]
        if "CCF" in prev["lists"]:
            metas["CCF"] = prev["lists"]["CCF"]
        rec.rows["CCF"] = []

    js = JournalSet(sjr_by_title)
    for k in LISTS:
        rows, old = rec.rows.get(k, []), prev_rows.get(k, [])
        if old and len(rows) < len(old) * SHRINK_LIMIT:
            if rows:
                warn(f"{k}: {len(rows)} rows (previously {len(old)}); keeping the previous data")
            elif k != "CCF" and k not in failed and not ("legacy" in failed and k in ("AJG", "FNEGE", "HCERES", "CNRS", "BFI")):
                warn(f"{k}: no rows; keeping the previous data")
            rows = old
            if k in prev["lists"]:
                metas[k] = prev["lists"][k]
        for title, issns, rank, note in rows:
            js.add(k, title, issns, rank, note)

    used = {k for e in js.entries for k in e["ranks"]} | ({"CCF"} if confs else set())
    for k in [k for k in metas if k not in used]:
        log(f"  {k}: no data, left out")
        metas.pop(k)
    out = {
        "built": dt.date.today().isoformat(),
        "lists": metas,
        "journals": js.rows(),
        "ccf": confs,
    }
    (DATA / "lists.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    log(f"  lists.json: {len(out['journals'])} journals, {len(confs)} CCF venues")


def write_index():
    """data/index.json: what the extension's catalog updater compares against its own copy."""
    files = {}
    for name in TABLES:
        path = DATA / f"{name}.json"
        blob = path.read_bytes()
        files[name] = {
            "sha256": hashlib.sha256(blob).hexdigest(),
            "bytes": len(blob),
            "built": json.loads(blob).get("built", ""),
        }
    index = {"schema": DATA_SCHEMA, "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
             "files": files, "warnings": WARNINGS}
    (DATA / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    log("index.json: " + ", ".join(f"{k} {v['built']}" for k, v in files.items()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--core-source", default=None, help="e.g. ICORE2026 (default: newest offered by the portal)")
    ap.add_argument("--sjr-csv", default=str(DATA / "scimagojr.csv"), help="manual scimagojr export; used if it exists")
    ap.add_argument("--skip-core", action="store_true")
    ap.add_argument("--skip-sjr", action="store_true")
    ap.add_argument("--skip-lists", action="store_true")
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)

    if not args.skip_core:
        source = args.core_source or detect_core_source()
        log(f"CORE: source {source}")
        try:
            build_core(source)
        except Exception as e:  # noqa: BLE001 - keep the previous table
            warn(f"CORE: source failed ({e}); keeping the previous table")
    if not args.skip_sjr:
        log("SJR:")
        try:
            build_sjr(args.sjr_csv)
        except Exception as e:  # noqa: BLE001
            warn(f"SJR: source failed ({e}); keeping the previous table")
    if not args.skip_lists:
        log("LISTS:")
        build_lists()
    missing = [n for n in TABLES if not (DATA / f"{n}.json").exists()]
    if missing:
        raise SystemExit(f"missing tables: {', '.join(missing)}")
    write_index()


if __name__ == "__main__":
    main()
