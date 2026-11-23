"""Shared vocabulary for the HN generative-AI imagery study.

Used by collect.py (search queries + which threads to expand) and analyze.py
(assigning posts to corpus tiers). Edit here to change the corpus definition.
"""

import re

# Queries sent to the Algolia HN Search API. Algolia matches all words of a
# query (not as an exact phrase), so analyze.py re-checks relevance with the
# regexes below.
SEARCH_QUERIES = [
    # AI imagery in games
    "AI art game",
    "AI generated art game",
    "AI generated assets",
    "AI assets game",
    "generative AI game",
    "genAI game",
    "AI game art",
    "AI artwork game",
    "AI images game",
    "Steam AI generated",
    "AI disclosure Steam",
    "AI concept art",
    "AI textures",
    "AI sprites",
    "AI slop game",
    "AI assisted art",
    "human assisted AI art",
    # Image generators
    "Midjourney",
    "Stable Diffusion",
    "DALL-E",
    "Adobe Firefly",
    "image generation AI",
    "text to image",
    # General generative-AI argument
    "AI art artists",
    "AI art copyright",
    "AI art theft",
    "AI art ethics",
    "generative AI artists",
    "generative AI copyright",
    "AI training data consent",
    "AI art lawsuit",
]

# Generative-AI terms with an imagery focus.
GENAI_IMAGE = re.compile(
    r"\b(ai[- ]?(generated|gen|made|created)\b|ai[- ]?(art|artwork|artists?|images?|imagery|"
    r"illustrations?|assets?|textures?|sprites?|slop|visuals?|graphics?|portraits?)\b|"
    r"generative (ai|art|models?|image)|gen[- ]?ai\b|midjourney|stable[- ]?diffusion|"
    r"\bsdxl\b|dall[- ·]?e|firefly|image (generat|synthes)|text[- ]to[- ]image|"
    r"diffusion models?|image models?|imagen\b|comfyui|"
    r"(ai|human)[- ]assisted)",
    re.I,
)

# General generative-AI terms (text, code, models), for the wider debate.
GENAI_GENERAL = re.compile(
    r"\b(generative ai|gen[- ]?ai|chatgpt|gpt-?[345]o?|llms?\b|large language models?|"
    r"openai|anthropic|claude|gemini|copilot|ai models?|foundation models?|"
    r"training data|trained on)",
    re.I,
)

# Video game context.
GAMES = re.compile(
    r"\b(video ?games?|games? (dev|development|developers?|studios?|industry|art|assets?|"
    r"design|designers?|engines?)|gamedev|indie (games?|devs?|developers?|studios?)|"
    r"steam\b|valve\b|itch\.io|unity\b|unreal( engine)?|godot|aaa\b|"
    r"(playstation|xbox|nintendo|switch 2)\b|rpgs?\b|mmos?\b|"
    r"activision|blizzard|ubisoft|\bea\b|electronic arts|bethesda|riot games|"
    r"epic games|square enix|capcom|sega\b|krafton|nexon|"
    r"concept art(ists?)?|sprites?|pixel art|gamers?|gaming)",
    re.I,
)

# The argument itself (labor, rights, ethics, quality).
DEBATE = re.compile(
    r"\b(artists?|illustrators?|copyright|infring|theft|steal|stolen|plagiar|"
    r"consent|licens|lawsuit|sued|court|fair use|jobs?|laid off|layoffs?|"
    r"livelihood|unemploy|ethic|moral|soulless|slop|creativ|craft|human[- ]made|"
    r"disclos|boycott|backlash|controvers)",
    re.I,
)

# "AI" that means game-playing / NPC AI rather than generative AI.
NON_GENERATIVE_AI = re.compile(
    r"\b(enemy|npc|opponent|bot|chess|go|game|pathfinding|behaviou?r tree|"
    r"alphago|alphastar|alphazero|openai five)\s+ai\b|\bai (opponents?|enemies|"
    r"difficulty|director|pathfinding)\b",
    re.I,
)


def is_genai_image(text: str) -> bool:
    return bool(GENAI_IMAGE.search(text or ""))


def is_genai_general(text: str) -> bool:
    return bool(GENAI_GENERAL.search(text or ""))


def is_games(text: str) -> bool:
    return bool(GAMES.search(text or ""))


def is_debate(text: str) -> bool:
    return bool(DEBATE.search(text or ""))
