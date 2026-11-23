# DistantReading: The Generative-AI Imagery Debate on Hacker News

## 1. Research goal

Map how Hacker News (HN) argues about AI-generated imagery in video games, and how
that debate sits within the wider argument over generative AI. Specifically:

- **RQ1. Topics:** What themes structure the discussion (e.g. artist labor, copyright
  and training data, quality and "slop", Steam/storefront disclosure rules, indie
  cost savings, tooling and workflows, human-in-the-loop "AI-assisted" art)?
- **RQ2. Sentiment and stance:** How positive or negative is the discussion, and how
  are people positioned (pro, anti, conditional) on each topic?
- **RQ3. Change over time:** How have topics and sentiment shifted since the 2022
  arrival of Stable Diffusion and Midjourney, and around key events (Steam's AI
  content policy, studio controversies, lawsuits)?
- **RQ4. Game imagery vs. general generative AI:** Does the game-imagery debate
  differ from general arguments over generative AI?

Deliverable: a static, web-friendly **D3.js dashboard** built on a reproducible
Python pipeline. All accounts are **pseudonymized**.

---

## 2. Data sources (HN's existing APIs)

| API | Use | Notes |
|---|---|---|
| **Algolia HN Search** `hn.algolia.com/api/v1` | Finding relevant stories and comments by keyword and date | `search_by_date`; `tags=story` / `comment`; `numericFilters=created_at_i>…`. Returns at most about 1,000 hits per query, so **query in date slices** (e.g. monthly). Limit is about 10k requests per hour. |
| **Official Firebase API** `hacker-news.firebaseio.com/v0/item/{id}.json` | Fetching **complete comment trees** for each relevant story | Lets us analyze whole threads, not just comments that match a keyword. No search. |

HN's official API has no search, so we use both: Algolia finds the stories and
comments, then Firebase fetches the full thread under each relevant story.

**Time window:** 2022-01-01 to the present (configurable).

---

## 3. Corpus definition

Two tiers, so that RQ4 can compare them:

- **Tier A: AI imagery in games.** A generative-AI image term appears together with a
  games term.
- **Tier B: general generative-AI debate.** Generative-AI argument threads
  (art, copyright, labor, ethics) without a games term.

**Seed vocabulary** (kept in `config/queries.yaml` and refined iteratively):

- *Gen-AI imagery:* "AI art", "AI-generated", "AI generated art", "generative AI",
  "genAI", "Stable Diffusion", "Midjourney", "DALL-E", "Firefly", "image
  generator", "diffusion model", "AI assets", "AI-assisted", "human-assisted",
  "AI slop", "text-to-image"
- *Games:* "video game", "game dev", "gamedev", "indie game", "Steam", "Valve",
  "game art", "concept art", "sprites", "textures", "Unity", "Unreal", "Godot",
  "AAA", "studio"
- *Debate markers (Tier B):* "artists", "copyright", "training data", "consent",
  "theft", "lawsuit", "jobs", "creativity"

**Relevance filtering** (keyword hits are noisy, e.g. "AI" also means NPC AI or
pathfinding):

1. Rule-based pre-filter (term co-occurrence and an exclusion list such as "enemy AI").
2. Hand-label about 300 random items as relevant or irrelevant.
3. Train a lightweight relevance classifier (sentence-embedding model plus logistic
   regression) and keep items above a threshold. Report precision and recall on a
   held-out set.

---

## 4. Ethics and pseudonymization

- **Pseudonyms:** each username becomes `HMAC-SHA256(secret_salt, username)`, which
  is then mapped to a readable stable label (e.g. `Participant-0417`). The salt lives
  in `.env` and is **never committed**. The same person gets the same pseudonym
  everywhere in the corpus.
- **Raw data stays private:** raw API responses go to `data/raw/` (gitignored).
  Only pseudonymized, processed data is committed or published.
- **Scrubbing text:** replace `@username` mentions and references to known corpus
  usernames inside comment text with their pseudonyms. Strip HN profile links
  (`news.ycombinator.com/user?id=…`).
- **Re-identification risk:** verbatim HN text can be found by searching, which
  would reveal the real account. On the dashboard, show **short excerpts only**
  (≤ 25 words) and no item IDs or HN links at the comment level. Story-level links
  (public articles) are fine.
- Exclude deleted and dead items. Record the collection date and the HN API terms in
  `docs/ethics.md`.

---

## 5. Pipeline architecture (Python 3.12)

```
config/            queries.yaml, pipeline.yaml
src/hnai/
  collect/         algolia.py, firebase.py   # rate-limited, resumable, cached
  anonymize.py     # HMAC pseudonyms + text scrubbing
  filter.py        # rule filter + relevance classifier
  preprocess.py    # HTML→text, quotes/code removal, lang detect, dedupe
  topics.py        # BERTopic (+ LDA baseline)
  sentiment.py     # sentiment + stance
  export.py        # dashboard JSON
data/raw/ (gitignored)  data/interim/  data/processed/
dashboard/         index.html, js/, css/, data/*.json
notebooks/         exploration + validation
tests/
```

**Stages** (each one can be cached and re-run, driven by `make` or a `dr` CLI):

1. `collect`: page through Algolia in monthly slices, then fetch full Firebase trees
   for relevant stories. Store everything as JSONL with retries and backoff.
2. `anonymize`: pseudonymize authors and scrub text. Nothing downstream ever sees
   a real username.
3. `filter`: assign Tier A or Tier B, or drop the item.
4. `preprocess`: convert HTML entities to text, strip `>` quoted replies (so quoted
   text isn't counted twice), remove code blocks and URLs, keep English only, and
   drop near-duplicates.
5. `topics`: **BERTopic** with `all-MiniLM-L6-v2` (or a similar small sentence
   model), UMAP for dimension reduction and HDBSCAN for clustering, plus
   `topics_over_time`. Run an **LDA baseline** (gensim) to check the results. Tune
   for topic coherence and readability. Name topics by hand after reviewing the top
   terms and representative documents.
6. `sentiment`:
   - Sentiment: a transformer model (e.g. `cardiffnlp/twitter-roberta-base-sentiment-latest`),
     with VADER as a baseline.
   - **Stance on generative AI** (pro / anti / conditional / neutral): zero-shot NLI
     or a few-shot LLM classifier, validated against about 300 hand-coded items.
     Stance answers the research question more directly than sentiment, because HN
     users often state support in a negative tone.
   - Report agreement (Cohen's κ and macro-F1) between the models and the hand
     codes.
7. `export`: compact JSON aggregates for the dashboard (see §6).

**Libraries:** `httpx`, `tenacity`, `pandas`/`polars`, `pyarrow`, `bertopic`,
`sentence-transformers`, `gensim`, `transformers`, `vaderSentiment`, `scikit-learn`,
`pytest`, `ruff`.

---

## 6. D3 dashboard

Static site (D3 v7, plain ES modules, no build step), so it can be deployed to GitHub
Pages. It reads precomputed JSON from `dashboard/data/`.

**Data files:** `meta.json`, `topics.json` (terms, labels, sizes),
`topic_time.json` (monthly prevalence by tier), `sentiment_time.json`,
`topic_sentiment.json` (topic × sentiment/stance matrix), `threads.json`
(per-thread reply-tree summaries), `excerpts.json` (short, pseudonymized examples).

**Views:**

1. **Overview header:** corpus size, date range, Tier A/B split, and a stance mix bar.
2. **Topic streamgraph:** topic prevalence over time, with annotated event markers
   (Steam policy, lawsuits, notable controversies).
3. **Topic map:** a 2-D scatter of topic positions (from the BERTopic embeddings),
   with circles sized by volume and colored by mean sentiment.
4. **Topic × sentiment/stance heatmap:** what share of each topic is pro, anti,
   conditional or neutral.
5. **Sentiment over time:** a smoothed line chart with confidence bands, with Tier A
   vs. Tier B as small multiples.
6. **Thread explorer:** a collapsible tree of one thread, with nodes colored by
   sentiment and labeled by pseudonym, showing how disagreement spreads through the
   replies.
7. **Topic detail panel:** top terms (bar chart), representative short excerpts, and
   the trend for that topic.

**Shared interactions:** filters for date range, tier and topic that apply across
all views; tooltips; a light/dark theme; a color palette that remains readable
with color-blindness; works on phone screens; keyboard access and ARIA labels.

---

## 7. Validation and reporting

- Hand-code a stratified sample (relevance, stance, sentiment) with a codebook in
  `docs/codebook.md`. Use a second coder on 20% of the sample if possible.
- Check topic stability across random seeds and against the LDA baseline.
- Write up methods, limitations and findings in `docs/report.md`. Known limitations:
  HN's demographics skew toward a particular kind of user, and keyword-based
  sampling introduces bias.

---

## 8. Milestones

| # | Deliverable | Est. |
|---|---|---|
| M0 | Repo setup (pyproject, ruff, pytest, CI), configs, `.env` handling | 1–2 days |
| M1 | Collectors (Algolia + Firebase), raw corpus, pseudonymization with tests | 1 week |
| M2 | Relevance filter + hand-labeled set, preprocessed corpus, descriptive stats | 1 week |
| M3 | Topic models (BERTopic + LDA), topic labeling | 1 week |
| M4 | Sentiment and stance models, validation against hand codes | 1 week |
| M5 | JSON export + D3 dashboard (views 1–5) | 1–2 weeks |
| M6 | Thread explorer, topic detail, polish, GitHub Pages deploy, report | 1 week |

---

## 9. Open decisions

- Final date range, and whether to also include Tier B threads with no image focus.
- Stance classifier choice: zero-shot NLI (free, runs locally) or LLM-based (more
  accurate, costs money for API calls).
- Excerpt policy: paraphrase instead of quoting if stricter anonymity is needed.
- Hosting: GitHub Pages (public) or private.
