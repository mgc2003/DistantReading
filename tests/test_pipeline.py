import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analyze  # noqa: E402
import collect  # noqa: E402

SALT = b"test-salt"


def test_pseudonyms_are_stable_and_salted():
    a, b = collect.Pseudonymizer(SALT), collect.Pseudonymizer(SALT)
    assert a.user("alice_99") == b.user("alice_99")
    assert a.user("alice_99").startswith("user-")
    assert a.user("alice_99") != collect.Pseudonymizer(b"other").user("alice_99")
    assert a.item(123) != a.item(124)
    assert "123" not in a.item(123)


def test_scrubber_replaces_rare_usernames_and_links():
    p = collect.Pseudonymizer(SALT)
    scrub = collect.TextScrubber(p, {"vunderba", "patio11", "finger", "ChatGPT", "x86"})
    out = scrub("As vunderba and @patio11 said, see https://news.ycombinator.com/user?id=vunderba "
                "and https://news.ycombinator.com/item?id=42.")
    assert "vunderba" not in out and "patio11" not in out
    assert p.user("vunderba") in out and "@" + p.user("patio11") in out
    assert "[hn-profile-link]" in out and "[hn-link]" in out


def test_scrubber_keeps_ordinary_words_and_vocabulary():
    p = collect.Pseudonymizer(SALT)
    scrub = collect.TextScrubber(p, {"finger", "ChatGPT", "x86", "Steam"})
    text = "A sixth finger, made with ChatGPT on x86, sold on Steam."
    assert scrub(text) == text


def test_unknown_mentions_are_masked():
    scrub = collect.TextScrubber(collect.Pseudonymizer(SALT), set())
    assert scrub("thanks @someone_else") == "thanks @[user]"


def test_html_to_text():
    html = '<p>Hello &amp; <i>bye</i><p><a href="https:&#x2F;&#x2F;x.com">x.com</a>'
    assert collect.html_to_text(html) == "Hello & bye\n\n https://x.com"


def test_tiers():
    games = {"story_title": "Steam now requires disclosure of AI-generated art"}
    debate = {"story_title": "Ask HN: thoughts on Midjourney?"}
    other = {"story_title": "Pathfinding for enemy AI in Godot"}
    assert analyze.assign_tier(games, "It looks fine to me") == "A"
    assert analyze.assign_tier(debate, "Artists should be paid") == "B"
    assert analyze.assign_tier(other, "A* is enough for NPCs") is None


def test_clean_text_drops_quotes_urls_pseudonyms():
    t = "> quoted reply\nI agree with user-1a2b3c4d, see https://example.com"
    assert analyze.clean_text(t) == "I agree with , see"


def test_excerpt_cap():
    assert analyze.excerpt("one two three four", 2) == "one two…"
