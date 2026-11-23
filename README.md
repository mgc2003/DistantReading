# DistantReading: the AI-imagery debate on Hacker News

A social-media research pipeline that studies how Hacker News (HN) argues about
**AI-generated imagery in video games**, compared with the wider **generative-AI
debate**. It has three parts:

| Part | File | What it does |
|---|---|---|
| Collection | `collect.py` | Searches HN, downloads full comment threads, **pseudonymizes every account** before writing anything to disk |
| Analysis | `analyze.py` | Assigns posts to corpus tiers, builds an NMF topic model, scores VADER sentiment, exports dashboard JSON |
| Dashboard | `dashboard/` | Static D3.js site, deployed to GitHub Pages |

See [`PLAN.md`](PLAN.md) for the research design.

## Quick start

```bash
pip install -r requirements.txt
python collect.py            # ~5 min: 2022-01-01 → today, writes data/posts.jsonl
python analyze.py            # ~1 min: writes dashboard/data/*.json
python -m http.server -d dashboard 8000   # open http://localhost:8000
```

`python collect.py --quick` runs a small smoke test (3 queries, last 60 days, 10 threads).

## Collection (`collect.py`)

1. **Search.** Each query in `terms.SEARCH_QUERIES` is sent to the
   [Algolia HN Search API](https://hn.algolia.com/api) (stories and comments). Algolia returns at most 1,000 hits per
   query, so busy date ranges are split in half until each piece fits.
2. **Threads.** The most relevant stories (AI imagery + games first) are expanded into full comment trees through
   Algolia's `/items` endpoint, with the [official HN Firebase API](https://github.com/HackerNews/API) as fallback.
   `--max-threads` (default 400) sets the limit.
3. **Pseudonymize, then write.** Real usernames are held only in memory while the script runs.
   * Usernames become `user-xxxxxxxx` (salted HMAC-SHA256), and they stay the same across runs that use the same salt.
   * HN item IDs become `i-xxxxxxxxxx`, so a post can't be looked up on HN.
   * `@mentions`, HN profile links and HN item links in the text are replaced or removed.
   * Usernames written as bare words in comment text are replaced, unless the username is an ordinary English word
     (`wordfreq`) or a study term such as "ChatGPT" or "Steam", so that normal sentences are left intact.

The salt is read from `$HN_PSEUDONYM_SALT`. If that isn't set, a salt is generated once and stored in
`.secrets/pseudonym_salt`, which is gitignored. **Keep the salt private**: anyone who has it can test whether a given
username is in the data.

Useful options: `--since 2023-01-01`, `--until 2025-01-01`, `--max-threads 200`, `--min-comment-hits 3`.

## Analysis (`analyze.py`)

* **Tiers.** *A: AI imagery in games* means the post or its story mentions generative-AI imagery and a games term.
  *B: Gen-AI debate* means generative-AI imagery without a games term, or general gen-AI alongside debate vocabulary
  (copyright, artists, jobs…). All other posts are excluded. The vocabulary lives in `terms.py`.
* **Cleaning.** Quoted replies (`>`), URLs, code blocks and pseudonyms are removed before modeling.
* **Topics.** TF-IDF on unigrams and bigrams, NMF with `--k` topics (default 14), and a 2-D topic map from classical
  MDS on the cosine distance between topics.
* **Sentiment.** VADER compound score averaged over a post's sentences. Posts with |score| < 0.05 count as neutral.

Name topics by hand in `config/topic_labels.json` (for example `{"7": "Copyright & law"}`), then re-run
`analyze.py`. Event markers on the timeline come from `config/events.json`.

Outputs:
* `dashboard/data/*.json`: aggregates, topic terms, excerpts of 25 words or fewer, and reply trees. These are published.
* `data/posts.jsonl` and `data/posts_scored.jsonl`: full pseudonymized text. These stay private (`data/` is gitignored).

## Dashboard

Views:
* Volume by month, with numbered event markers
* Sentiment by month for each tier
* Topic map
* Sentiment share by topic
* Topic share over time (small multiples)
* Sentiment histogram
* Topic detail (terms and excerpts)
* Radial thread explorer

Shared filters (date range, tier, topic) apply to every view. Each card has a **Table** toggle. The site has light and
dark themes and works at phone width. D3 v7.9.0 is bundled in `dashboard/js/vendor/`, so the site needs no CDN or
build step.

### Publishing on GitHub Pages

The workflow `.github/workflows/pages.yml` deploys `dashboard/` whenever `main` changes. To set it up once:

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Merge this branch into `main`, or run the *Deploy dashboard to GitHub Pages* workflow by hand.
3. The site is served at `https://<owner>.github.io/DistantReading/`.

To refresh the data, re-run `collect.py` and `analyze.py`, then commit `dashboard/data/`.

## Tests

```bash
python -m pytest -q tests
```

## Limitations and ethics

* Keyword sampling misses posts that don't use the vocabulary, and HN's users are not representative of the public.
* VADER measures tone, not stance: a critical-sounding comment can still support AI art. It also reads HN's technical
  prose as mildly positive, so compare sentiment between groups and over time rather than as absolute levels.
* NMF usually produces one broad, generic topic. Review the topics and name them before drawing conclusions.
* Excerpts are short and not linked to HN, but verbatim text can still be found with a search engine. For stricter
  anonymity, set `--excerpt-words 0` or paraphrase.
* Data comes from public HN APIs. Respect their rate limits and HN's terms of use.
