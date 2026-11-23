#!/usr/bin/env python3
"""Analyze the pseudonymized Hacker News corpus produced by collect.py.

Steps
  1. Clean text (drop quoted replies, URLs, code, pseudonym tokens).
  2. Assign each post to a corpus tier:
       A  "AI imagery in games"    generative-AI imagery + games context
       B  "Generative-AI debate"   generative AI (imagery, or general gen-AI
                                    alongside debate vocabulary), no games context
     Posts matching neither are excluded.
  3. Topic model: TF-IDF (unigrams + bigrams) and NMF with k topics. Topics are
     placed on a 2-D map with MDS over the cosine distance between topics.
  4. Sentiment: VADER compound score, averaged over a post's sentences.
  5. Export compact JSON for the D3 dashboard (dashboard/data/) and a private
     per-post table (data/posts_scored.jsonl).

Usage
  python analyze.py                 # reads data/posts.jsonl
  python analyze.py --k 14 --excerpt-words 20
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.decomposition import NMF
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

import terms

ROOT = Path(__file__).resolve().parent

TIERS = {
    "A": "AI imagery in games",
    "B": "Generative-AI debate",
}

# Words that carry no topical signal in HN discussion (beyond sklearn's list).
EXTRA_STOP = """
ai just like think people really don doesn didn isn aren wasn ve ll re let
would could should one also get got even much many thing things way going make
makes made know want say said lot actually pretty something someone use used
using good well yes sure see still need right time point mean probably maybe
come comes look looks lot lots kind sort quite bit able different better best
work works working new year years day days far long little big real really
case example sense course fact rather already though anything everything
nothing every less last first take takes given give point idea feel feels
yeah oh ok okay hn comment comments post article thread link user users
does doing did done doesn going goes went gone getting got gets stuff guess
probably definitely literally basically simply exactly agree disagree
true false problem problems question answer reason talking talk saying says
able possible likely different similar general specific person way ways
instead especially certainly obviously simply generally maybe perhaps
try trying tried look looking looked read reading wrote write writing
dont doesnt didnt isnt cant wont im ive youre theyre thats theres whats
https http www com org html en wiki wikipedia reddit youtube
""".split()
STOPWORDS = sorted(set(ENGLISH_STOP_WORDS) | set(EXTRA_STOP))

URL_RE = re.compile(r"https?://\S+|www\.\S+")
PSEUDO_RE = re.compile(r"@?user-[0-9a-f]{8}|@\[user\]|\[hn-(profile-)?link\]")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")


# ------------------------------------------------------------------ Helpers

def clean_text(text: str) -> str:
    """Text used for modeling: own words only, no quotes/URLs/pseudonyms/code."""
    lines = []
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith(">") or s.startswith("    "):
            continue
        lines.append(line)
    t = "\n".join(lines)
    t = URL_RE.sub(" ", t)
    t = PSEUDO_RE.sub(" ", t)
    return re.sub(r"[ \t]+", " ", t).strip()


def excerpt(text: str, n_words: int) -> str:
    if n_words <= 0:
        return ""
    t = re.sub(r"\s+", " ", PSEUDO_RE.sub("[user]", URL_RE.sub("[link]", text))).strip()
    words = t.split(" ")
    return " ".join(words[:n_words]) + ("…" if len(words) > n_words else "")


def assign_tier(post: dict, clean: str) -> str | None:
    title = post.get("story_title") or post.get("title") or ""
    context = f"{title}\n{clean}"
    img = terms.is_genai_image(context)
    games = terms.is_games(context)
    general = terms.is_genai_general(context)
    if img and games:
        return "A"
    if img or (general and terms.is_debate(clean)):
        return "B"
    return None


def month_of(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")


def sentiment(analyzer: SentimentIntensityAnalyzer, text: str) -> float:
    sents = [s for s in SENT_SPLIT.split(text) if len(s.split()) >= 3]
    if not sents:
        return analyzer.polarity_scores(text)["compound"] if text else 0.0
    return float(np.mean([analyzer.polarity_scores(s)["compound"] for s in sents]))


def classical_mds(dist: np.ndarray) -> np.ndarray:
    """Deterministic 2-D classical (Torgerson) MDS of a distance matrix."""
    n = dist.shape[0]
    J = np.eye(n) - np.ones((n, n)) / n
    B = -0.5 * J @ (dist ** 2) @ J
    vals, vecs = np.linalg.eigh(B)
    idx = vals.argsort()[::-1][:2]
    coords = vecs[:, idx] * np.sqrt(np.clip(vals[idx], 0, None))
    return coords * np.sign(coords.sum(axis=0) + 1e-12)  # stable orientation


def label_sent(score: float, band: float) -> str:
    return "pos" if score >= band else "neg" if score <= -band else "neu"


# --------------------------------------------------------------------- Main

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", default=str(ROOT / "data" / "posts.jsonl"))
    ap.add_argument("--out-dir", default=str(ROOT / "dashboard" / "data"))
    ap.add_argument("--k", type=int, default=14, help="number of topics")
    ap.add_argument("--min-words", type=int, default=8, help="min words for a post to enter the topic model")
    ap.add_argument("--excerpt-words", type=int, default=25, help="max words per excerpt shown on the dashboard")
    ap.add_argument("--neutral-band", type=float, default=0.05, help="|score| below this is neutral")
    ap.add_argument("--threads", type=int, default=25, help="threads exported to the thread explorer")
    ap.add_argument("--thread-nodes", type=int, default=250, help="max comments per exported thread")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    posts = [json.loads(line) for line in open(args.input, encoding="utf-8")]
    log(f"Loaded {len(posts)} posts")

    # 1–2. clean + tier
    analyzer = SentimentIntensityAnalyzer()
    kept = []
    for p in posts:
        own = f"{p.get('title') or ''}\n{p.get('text') or ''}".strip()
        c = clean_text(own)
        tier = assign_tier(p, c)
        if tier is None or not c:
            continue
        p["clean"] = c
        p["tier"] = tier
        p["words"] = len(c.split())
        p["month"] = month_of(p["time"])
        kept.append(p)
    log(f"Relevant posts: {len(kept)} (A={sum(p['tier']=='A' for p in kept)}, "
        f"B={sum(p['tier']=='B' for p in kept)}); excluded {len(posts) - len(kept)}")

    # 4. sentiment (all relevant posts)
    for p in kept:
        p["sent"] = round(sentiment(analyzer, p["clean"]), 4)
        p["sent_label"] = label_sent(p["sent"], args.neutral_band)

    # 3. topic model
    model_docs = [p for p in kept if p["words"] >= args.min_words]
    log(f"Topic model on {len(model_docs)} posts, k={args.k}")
    vec = TfidfVectorizer(
        stop_words=STOPWORDS, ngram_range=(1, 2), min_df=5, max_df=0.4,
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9-]{2,}\b", sublinear_tf=True, max_features=30000,
    )
    X = vec.fit_transform([p["clean"].lower().replace("\u2019", "'") for p in model_docs])
    nmf = NMF(n_components=args.k, init="nndsvda", random_state=args.seed, max_iter=400)
    W = nmf.fit_transform(X)
    H = nmf.components_
    vocab = np.array(vec.get_feature_names_out())

    row_sum = W.sum(axis=1, keepdims=True)
    share = np.divide(W, row_sum, out=np.zeros_like(W), where=row_sum > 0)
    for p, w, s in zip(model_docs, W, share):
        if w.max() <= 0:
            p["topic"] = -1
        else:
            p["topic"] = int(s.argmax())
            p["topic_weight"] = float(s.max())
    for p in kept:
        p.setdefault("topic", -1)

    # topic map
    sim = cosine_similarity(H)
    dist = np.clip(1 - sim, 0, None)
    np.fill_diagonal(dist, 0)
    coords = classical_mds(dist)

    # 5. export
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    labels_path = ROOT / "config" / "topic_labels.json"
    custom_labels = json.loads(labels_path.read_text()) if labels_path.exists() else {}
    events_path = ROOT / "config" / "events.json"
    events = json.loads(events_path.read_text()) if events_path.exists() else []

    topics = []
    for k in range(args.k):
        top = H[k].argsort()[::-1][:15]
        members = [p for p in model_docs if p["topic"] == k]
        sents = [p["sent"] for p in members]
        lab = Counter(p["sent_label"] for p in members)
        reps = sorted((p for p in members if p["words"] >= 12), key=lambda p: -p["topic_weight"])[:8]
        topics.append({
            "id": k,
            "label": custom_labels.get(str(k)) or " · ".join(vocab[top[:3]]),
            "auto_label": " · ".join(vocab[top[:3]]),
            "terms": [{"term": vocab[i], "weight": round(float(H[k, i]), 4)} for i in top],
            "n": len(members),
            "tiers": dict(Counter(p["tier"] for p in members)),
            "sentiment": {
                "mean": round(float(np.mean(sents)), 4) if sents else 0,
                "pos": lab["pos"], "neu": lab["neu"], "neg": lab["neg"],
            },
            "x": round(float(coords[k, 0]), 4),
            "y": round(float(coords[k, 1]), 4),
            "examples": [{
                "text": excerpt(p["clean"], args.excerpt_words),
                "author": p["author"],
                "month": p["month"],
                "tier": p["tier"],
                "sent": p["sent"],
            } for p in reps],
        })

    # timeline rows: month × tier × topic
    agg = defaultdict(lambda: {"n": 0, "s": 0.0, "pos": 0, "neg": 0})
    hist = Counter()
    for p in kept:
        key = (p["month"], p["tier"], p["topic"])
        a = agg[key]
        a["n"] += 1
        a["s"] += p["sent"]
        a[p["sent_label"]] = a.get(p["sent_label"], 0) + 1
        b = min(9, int((p["sent"] + 1) / 0.2))  # 10 bins over [-1, 1]
        hist[(p["month"], p["tier"], p["topic"], b)] += 1
    timeline = [{"m": m, "t": t, "k": k, "n": a["n"], "s": round(a["s"], 4), "pos": a["pos"],
                 "neg": a["neg"]} for (m, t, k), a in sorted(agg.items())]
    histogram = [{"m": m, "t": t, "k": k, "b": b, "n": n} for (m, t, k, b), n in sorted(hist.items())]

    # thread explorer
    by_id = {p["id"]: p for p in posts}
    kept_ids = {p["id"]: p for p in kept}
    children = defaultdict(list)
    for p in posts:
        if p.get("parent"):
            children[p["parent"]].append(p)
    story_posts = [p for p in posts if p["type"] == "story" and p["source"] == "thread" and p["id"] in kept_ids]
    relevant_per_story = Counter(p["story"] for p in kept)
    story_posts.sort(key=lambda s: (kept_ids[s["id"]]["tier"] == "A", relevant_per_story[s["id"]]),
                     reverse=True)

    def build(node_id, budget):
        p = kept_ids.get(node_id) or by_id.get(node_id)
        if budget[0] <= 0:
            return None
        budget[0] -= 1
        c = p.get("clean") or clean_text(p.get("text") or "")
        s = p.get("sent")
        if s is None:
            s = round(sentiment(analyzer, c), 4) if c else 0.0
        node = {
            "a": p["author"],
            "m": month_of(p["time"]),
            "s": s,
            "k": p.get("topic", -1),
            "x": excerpt(c, args.excerpt_words) if c else "",
        }
        kids = sorted(children.get(node_id, []), key=lambda q: q["time"] or 0)
        built = [b for b in (build(q["id"], budget) for q in kids) if b]
        if built:
            node["c"] = built
        return node

    threads = []
    for s in story_posts[: args.threads]:
        budget = [args.thread_nodes + 1]
        tree = build(s["id"], budget)
        tree["title"] = s.get("title")
        tree["url"] = s.get("url")
        tree["tier"] = kept_ids[s["id"]]["tier"]
        tree["size"] = args.thread_nodes + 1 - budget[0]
        threads.append(tree)

    coll_meta_path = Path(args.input).parent / "collection_meta.json"
    coll_meta = json.loads(coll_meta_path.read_text()) if coll_meta_path.exists() else {}
    months = sorted({p["month"] for p in kept})
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "collection": {k: coll_meta.get(k) for k in
                       ("collected_at", "since", "until", "posts", "accounts", "threads_expanded")},
        "tiers": TIERS,
        "counts": {
            "posts": len(kept),
            "modeled": len(model_docs),
            "accounts": len({p["author"] for p in kept}),
            "threads": len({p["story"] for p in kept}),
            "by_tier": dict(Counter(p["tier"] for p in kept)),
            "by_sentiment": dict(Counter(p["sent_label"] for p in kept)),
        },
        "months": months,
        "params": {
            "k": args.k, "min_words": args.min_words, "neutral_band": args.neutral_band,
            "excerpt_words": args.excerpt_words, "vectorizer": "tf-idf 1-2gram min_df=5 max_df=0.4",
            "topic_model": "NMF (nndsvda)", "sentiment": "VADER compound, mean over sentences",
        },
        "reconstruction_error": round(float(nmf.reconstruction_err_), 3),
    }

    files = {
        "meta.json": meta, "topics.json": topics, "timeline.json": timeline,
        "histogram.json": histogram, "threads.json": threads, "events.json": events,
    }
    for name, obj in files.items():
        (out / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        log(f"  wrote {out / name} ({(out / name).stat().st_size / 1024:.0f} KB)")

    # private per-post table for further research (not published)
    private = Path(args.input).parent / "posts_scored.jsonl"
    with private.open("w", encoding="utf-8") as f:
        for p in kept:
            f.write(json.dumps({k: p.get(k) for k in (
                "id", "type", "author", "time", "month", "story", "parent", "tier",
                "topic", "topic_weight", "sent", "sent_label", "words", "clean")}, ensure_ascii=False) + "\n")
    log(f"  wrote {private}")

    for t in topics:
        log(f"  topic {t['id']:2d} n={t['n']:5d} sent={t['sentiment']['mean']:+.3f}  {', '.join(x['term'] for x in t['terms'][:8])}")


if __name__ == "__main__":
    main()
