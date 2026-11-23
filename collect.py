#!/usr/bin/env python3
"""Collect Hacker News posts about generative-AI imagery (in games and in general).

Steps
  1. Search the Algolia HN Search API for every query in terms.SEARCH_QUERIES,
     in date slices (Algolia returns at most 1,000 hits per query, so busy
     date ranges are split in half until each piece fits).
  2. Pick the most relevant stories and download their full comment trees
     (Algolia /items endpoint, falling back to the official Firebase API).
  3. Pseudonymize everything before anything is written to disk:
       * usernames  -> stable "user-xxxxxxxx" labels (salted HMAC-SHA256)
       * HN item ids -> stable "i-xxxxxxxxxx" labels (so a post can't be looked up)
       * usernames mentioned inside comment text, HN profile links and HN item
         links are replaced or removed.
     Real usernames exist only in memory while the script runs.

Output
  data/posts.jsonl          one pseudonymized post per line
  data/collection_meta.json run parameters and counts

The salt comes from $HN_PSEUDONYM_SALT, or is generated once and stored in
.secrets/pseudonym_salt (gitignored). Keep it private: anyone holding the salt
can test whether a given username is in the data. Re-using it keeps pseudonyms
stable across runs.

Usage
  python collect.py                          # defaults: 2022-01-01 .. today
  python collect.py --since 2023-01-01 --max-threads 200
  python collect.py --quick                  # small smoke test
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import terms

ALGOLIA = "https://hn.algolia.com/api/v1"
FIREBASE = "https://hacker-news.firebaseio.com/v0"
ROOT = Path(__file__).resolve().parent
USER_AGENT = "DistantReading-research-collector/1.0"
HN_USERNAME = r"[A-Za-z0-9_-]{2,15}"


# --------------------------------------------------------------------------- HTTP

def get_json(url: str, retries: int = 5, timeout: int = 30):
    """GET a URL and parse JSON, retrying with exponential backoff."""
    delay = 1.0
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == retries - 1:
                raise
            if e.code == 429:
                delay = max(delay, 30)
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            if attempt == retries - 1:
                raise
        time.sleep(delay)
        delay *= 2
    return None


# ------------------------------------------------------------------------- Search

def search_slice(query: str, start: int, end: int, pause: float, log) -> list[dict]:
    """All story/comment hits for `query` created in [start, end).

    Algolia returns at most 1,000 hits per query and its hit count is only
    approximate, so any slice reporting more than SPLIT_AT hits is halved
    recursively until each piece fits.
    """
    params = {
        "query": query,
        "tags": "(story,comment)",
        "hitsPerPage": 1000,
        "numericFilters": f"created_at_i>={start},created_at_i<{end}",
    }
    data = get_json(f"{ALGOLIA}/search_by_date?{urllib.parse.urlencode(params)}")
    time.sleep(pause)
    if not data:
        return []
    n = data.get("nbHits", 0)
    if n > SPLIT_AT and end - start > 3600:
        mid = (start + end) // 2
        return search_slice(query, start, mid, pause, log) + search_slice(query, mid, end, pause, log)
    if n > 1000:
        log(f"    ! {query!r}: >1000 hits within one hour, keeping first 1000")
    return list(data.get("hits", []))


SPLIT_AT = 900


def run_search(queries, since, until, pause, workers, log) -> tuple[dict, dict]:
    """Returns ({objectID: hit}, {objectID: set(queries)})."""
    hits: dict[str, dict] = {}
    matched: dict[str, set] = defaultdict(set)
    start, end = int(since.timestamp()), int(until.timestamp())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(search_slice, q, start, end, pause, log): q for q in queries}
        for i, fut in enumerate(as_completed(futures), 1):
            q = futures[fut]
            found = fut.result()
            n_before = len(hits)
            for h in found:
                hits[h["objectID"]] = h
                matched[h["objectID"]].add(q)
            log(f"  [{i}/{len(queries)}] {q!r}: {len(found)} hits, +{len(hits) - n_before} new (total {len(hits)})")
    return hits, matched


# -------------------------------------------------------------------- Threads

def pick_threads(hits: dict, max_threads: int, min_comment_hits: int) -> list[int]:
    """Choose which stories to expand into full comment trees.

    A story qualifies if its title/text mentions AI imagery, or at least
    `min_comment_hits` matching comments were posted under it. Stories about AI
    imagery in games rank first, then by matching comments, then by size.
    """
    story_info: dict[int, dict] = {}
    comment_hits = Counter()
    for h in hits.values():
        tags = h.get("_tags", [])
        if "story" in tags:
            sid = int(h["objectID"])
            text = f"{h.get('title') or ''} {h.get('story_text') or ''}"
            story_info[sid] = {
                "genai": terms.is_genai_image(text),
                "games": terms.is_games(text),
                "size": h.get("num_comments") or 0,
            }
        elif h.get("story_id"):
            comment_hits[int(h["story_id"])] += 1
            sid = int(h["story_id"])
            title = h.get("story_title") or ""
            info = story_info.setdefault(sid, {"genai": False, "games": False, "size": 0})
            info["genai"] |= terms.is_genai_image(title)
            info["games"] |= terms.is_games(title)

    candidates = []
    for sid, info in story_info.items():
        n = comment_hits[sid]
        if not (info["genai"] or n >= min_comment_hits):
            continue
        if info["size"] == 0 and n == 0:
            continue  # story with no discussion
        priority = (info["genai"] and info["games"], info["genai"], n, info["size"])
        candidates.append((priority, sid))
    candidates.sort(reverse=True)
    return [sid for _, sid in candidates[:max_threads]]


def fetch_tree_algolia(story_id: int) -> dict | None:
    return get_json(f"{ALGOLIA}/items/{story_id}")


def fetch_tree_firebase(story_id: int, cap: int = 3000) -> dict | None:
    """Fallback: rebuild an Algolia-shaped tree from the official API."""
    def node(item_id: int, budget: list[int]):
        if budget[0] <= 0:
            return None
        it = get_json(f"{FIREBASE}/item/{item_id}.json")
        if not it:
            return None
        budget[0] -= 1
        return {
            "id": it["id"],
            "type": it.get("type"),
            "author": None if it.get("deleted") or it.get("dead") else it.get("by"),
            "text": None if it.get("deleted") or it.get("dead") else it.get("text"),
            "title": it.get("title"),
            "url": it.get("url"),
            "points": it.get("score"),
            "created_at_i": it.get("time"),
            "parent_id": it.get("parent"),
            "story_id": story_id,
            "children": [c for c in (node(k, budget) for k in it.get("kids", [])) if c],
        }
    return node(story_id, [cap])


def flatten(tree: dict) -> list[dict]:
    out, stack = [], [tree]
    while stack:
        n = stack.pop()
        out.append(n)
        stack.extend(n.get("children") or [])
    return out


def fetch_threads(story_ids, workers, log) -> dict[int, list[dict]]:
    threads: dict[int, list[dict]] = {}

    def job(sid):
        tree = None
        try:
            tree = fetch_tree_algolia(sid)
        except Exception:
            pass
        if not tree:
            tree = fetch_tree_firebase(sid)
        return sid, tree

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(job, sid) for sid in story_ids]
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                sid, tree = fut.result()
            except Exception as e:  # keep going; one bad thread shouldn't stop the run
                log(f"    ! thread failed: {e}")
                continue
            if tree:
                threads[sid] = flatten(tree)
            if i % 25 == 0 or i == len(futures):
                log(f"  threads {i}/{len(futures)}")
    return threads


# ------------------------------------------------------------- Text cleaning

TAG_RE = re.compile(r"<[^>]+>")
LINK_RE = re.compile(r'<a\s+[^>]*href="([^"]*)"[^>]*>.*?</a>', re.I | re.S)


def html_to_text(s: str | None) -> str:
    if not s:
        return ""
    s = LINK_RE.sub(lambda m: f" {html.unescape(m.group(1))} ", s)
    s = re.sub(r"</?p>", "\n\n", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = TAG_RE.sub("", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


# ---------------------------------------------------------- Pseudonymization

def load_salt() -> bytes:
    env = os.environ.get("HN_PSEUDONYM_SALT")
    if env:
        return env.encode()
    path = ROOT / ".secrets" / "pseudonym_salt"
    if path.exists():
        return path.read_text().strip().encode()
    path.parent.mkdir(exist_ok=True)
    salt = secrets.token_hex(32)
    path.write_text(salt + "\n")
    os.chmod(path, 0o600)
    return salt.encode()


class Pseudonymizer:
    def __init__(self, salt: bytes):
        self.salt = salt
        self._users: dict[str, str] = {}

    def _digest(self, kind: str, value: str) -> str:
        return hmac.new(self.salt, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()

    def user(self, name: str | None) -> str | None:
        if not name:
            return None
        if name not in self._users:
            self._users[name] = "user-" + self._digest("user", name)[:8]
        return self._users[name]

    def item(self, item_id) -> str | None:
        if item_id is None:
            return None
        return "i-" + self._digest("item", str(item_id))[:10]


class TextScrubber:
    """Removes usernames and HN links from post text.

    * HN profile / item links are always removed.
    * "@name" becomes the pseudonym if name is a known author, otherwise "@[user]".
    * A bare word equal to a known author's username is replaced unless it is
      an ordinary English word (wordfreq Zipf frequency >= `common_zipf`, e.g.
      "finger", "recursive") or looks like a number / tech token ("x86",
      "ps2", "gpt-4", "1080p"), so normal sentences are not mangled. A
      username that is also a common word ("dang", "pg") is therefore kept
      where it appears as a bare word; that is the accepted trade-off.
    """

    HN_USER_LINK = re.compile(
        r"https?://news\.ycombinator\.com/(user|submitted|threads|favorites)\?id=" + HN_USERNAME, re.I)
    HN_ITEM_LINK = re.compile(r"https?://news\.ycombinator\.com/item\?id=\d+\S*", re.I)
    AT_MENTION = re.compile(r"(?<![\w@])@(" + HN_USERNAME + r")\b")
    TOKEN = re.compile(r"(?<![\w@/.$-])(" + HN_USERNAME + r")(?![\w-])")
    TECHY = re.compile(r"^(\d+[a-z]{0,3}|[a-z]{1,4}-?\d+[a-z]{0,2}|\d+x\d+|v?\d+(\.\d+)*)$", re.I)

    def __init__(self, pseudo: Pseudonymizer, usernames: set[str], common_zipf: float = 2.0):
        from wordfreq import zipf_frequency

        self.pseudo = pseudo
        self.replace = {}
        for u in usernames:
            if len(u) < 3 or not re.search(r"[A-Za-z]", u) or self.TECHY.match(u):
                continue
            if zipf_frequency(u, "en") >= common_zipf:
                continue
            if any(rx.search(u) for rx in (terms.GENAI_IMAGE, terms.GENAI_GENERAL, terms.GAMES)):
                continue  # product / study vocabulary ("ChatGPT", "Midjourney", "Steam")
            self.replace[u] = pseudo.user(u)
        self.known = usernames

    def __call__(self, text: str) -> str:
        text = self.HN_USER_LINK.sub("[hn-profile-link]", text)
        text = self.HN_ITEM_LINK.sub("[hn-link]", text)
        text = self.AT_MENTION.sub(
            lambda m: "@" + self.pseudo.user(m.group(1)) if m.group(1) in self.known else "@[user]", text)
        return self.TOKEN.sub(lambda m: self.replace.get(m.group(1), m.group(1)), text)


# ------------------------------------------------------------------- Records

def build_records(hits, matched, threads, salt, log) -> list[dict]:
    """Merge search hits and thread items into pseudonymized post records."""
    raw: dict[int, dict] = {}

    # Thread items first (complete context), then search hits not already present.
    for sid, items in threads.items():
        root_title = next((i.get("title") for i in items if i["id"] == sid), None)
        for it in items:
            if it.get("type") not in ("story", "comment"):
                continue
            raw[it["id"]] = {
                "id": it["id"],
                "type": it["type"],
                "author": it.get("author"),
                "time": it.get("created_at_i"),
                "parent": it.get("parent_id"),
                "story": it.get("story_id") or sid,
                "title": it.get("title") if it["type"] == "story" else None,
                "story_title": root_title,
                "url": it.get("url") if it["type"] == "story" else None,
                "points": it.get("points") if it["type"] == "story" else None,
                "html": it.get("text"),
                "source": "thread",
            }
    for oid, h in hits.items():
        iid = int(oid)
        is_story = "story" in h.get("_tags", [])
        q = sorted(matched.get(oid, []))
        if iid in raw:
            raw[iid]["queries"] = q
            continue
        raw[iid] = {
            "id": iid,
            "type": "story" if is_story else "comment",
            "author": h.get("author"),
            "time": h.get("created_at_i"),
            "parent": h.get("parent_id"),
            "story": iid if is_story else h.get("story_id"),
            "title": h.get("title") if is_story else None,
            "story_title": h.get("title") if is_story else h.get("story_title"),
            "url": h.get("url") if is_story else None,
            "points": h.get("points") if is_story else None,
            "html": h.get("story_text") if is_story else h.get("comment_text"),
            "source": "search",
            "queries": q,
        }

    # Drop deleted / dead items (no author or no content).
    rows = [r for r in raw.values() if r["author"] and (r["html"] or r["title"])]
    for r in rows:
        r["text"] = html_to_text(r.pop("html"))

    pseudo = Pseudonymizer(salt)
    usernames = {r["author"] for r in rows}
    scrub = TextScrubber(pseudo, usernames)
    log(f"  {len(rows)} posts by {len(usernames)} distinct accounts; "
        f"{len(scrub.replace)} usernames eligible for in-text replacement")

    out = []
    for r in sorted(rows, key=lambda r: (r["time"] or 0, r["id"])):
        out.append({
            "id": pseudo.item(r["id"]),
            "type": r["type"],
            "author": pseudo.user(r["author"]),
            "time": r["time"],
            "parent": pseudo.item(r["parent"]) if r["type"] == "comment" else None,
            "story": pseudo.item(r["story"]),
            "title": scrub(r["title"]) if r["title"] else None,
            "story_title": scrub(r["story_title"]) if r["story_title"] else None,
            "url": r["url"],
            "points": r["points"],
            "text": scrub(r["text"]),
            "source": r["source"],
            "queries": r.get("queries", []),
        })
    return out


# ---------------------------------------------------------------------- Main

def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default="2022-01-01", help="start date YYYY-MM-DD (UTC)")
    ap.add_argument("--until", default=None, help="end date YYYY-MM-DD (UTC, exclusive); default now")
    ap.add_argument("--max-threads", type=int, default=400, help="max stories to expand into full threads")
    ap.add_argument("--min-comment-hits", type=int, default=3,
                    help="matching comments needed to expand a story whose title isn't about AI imagery")
    ap.add_argument("--workers", type=int, default=6, help="parallel thread downloads")
    ap.add_argument("--pause", type=float, default=0.5,
                    help="seconds each search worker waits between requests (Algolia allows ~10k/hour)")
    ap.add_argument("--search-workers", type=int, default=2, help="parallel search queries")
    ap.add_argument("--out", default=str(ROOT / "data" / "posts.jsonl"))
    ap.add_argument("--quick", action="store_true", help="smoke test: 3 queries, 3 months, 10 threads")
    args = ap.parse_args(argv)

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    since = parse_date(args.since)
    until = parse_date(args.until) if args.until else datetime.now(timezone.utc)
    queries = terms.SEARCH_QUERIES
    if args.quick:
        queries = queries[:3]
        since = max(since, until - timedelta(days=60))
        args.max_threads = 10

    salt = load_salt()
    t0 = time.time()
    log(f"Searching {len(queries)} queries, {since:%Y-%m-%d} → {until:%Y-%m-%d}")
    hits, matched = run_search(queries, since, until, args.pause, args.search_workers, log)

    story_ids = pick_threads(hits, args.max_threads, args.min_comment_hits)
    log(f"Expanding {len(story_ids)} threads")
    threads = fetch_threads(story_ids, args.workers, log)

    log("Pseudonymizing")
    records = build_records(hits, matched, threads, salt, log)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    meta = {
        "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "since": since.date().isoformat(),
        "until": until.date().isoformat(),
        "queries": queries,
        "search_hits": len(hits),
        "threads_expanded": len(threads),
        "posts": len(records),
        "stories": sum(r["type"] == "story" for r in records),
        "comments": sum(r["type"] == "comment" for r in records),
        "accounts": len({r["author"] for r in records}),
        "seconds": round(time.time() - t0, 1),
    }
    (out.parent / "collection_meta.json").write_text(json.dumps(meta, indent=2))
    log(f"Wrote {len(records)} posts → {out}  ({meta['seconds']}s)")


if __name__ == "__main__":
    main()
