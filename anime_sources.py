#!/usr/bin/env python3
"""
Movie Night anime source helper.

Uses the open-source anicli-api AnimeGo extractor to discover the Kodik
players exposed for an anime episode. No Kodik API token is used here.

Input:
  --title "Russian title"
  --orig "Original title"
  --year 2024

Output: one JSON object on stdout.
All diagnostics go to stderr so Node can parse stdout safely.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from urllib.parse import urlparse


def log(*parts: object) -> None:
    print("[anime_sources]", *parts, file=sys.stderr, flush=True)


def normalize(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    text = text.replace("ё", "е")
    text = re.sub(r"[^0-9a-zа-я]+", " ", text, flags=re.IGNORECASE)
    return " ".join(text.split())


def similarity(a: object, b: object) -> float:
    a_n = normalize(a)
    b_n = normalize(b)

    if not a_n or not b_n:
        return 0.0

    if a_n == b_n:
        return 1.0

    if a_n in b_n or b_n in a_n:
        return 0.92

    return SequenceMatcher(None, a_n, b_n).ratio()


KODIK_PLAYER_PATH = re.compile(
    r"^/(?:seria|serial|season|video|film|episode|uv)/"
    r"\d+/[A-Za-z0-9_-]+/\d{3,4}p/?$",
    flags=re.IGNORECASE,
)


def normalize_player_url(url: object) -> str:
    raw = str(url or "").strip()

    if raw.startswith("//"):
        raw = f"https:{raw}"
    elif raw.startswith("http://"):
        raw = f"https://{raw[len('http://'):]}"

    return raw


def source_is_kodik(url: object) -> bool:
    """
    Kodik-compatible players are NOT guaranteed to use a hostname containing
    the word "kodik". anicli-api itself recognizes them primarily by player
    URL shape. AnimeGo can return compatible provider domains such as anivod
    or other aliases.
    """
    try:
        parsed = urlparse(normalize_player_url(url))

        if parsed.scheme != "https:":
            return False

        if not parsed.hostname:
            return False

        return bool(KODIK_PLAYER_PATH.match(parsed.path))
    except Exception:
        return False


def canonical_kodik_url(url: object) -> str | None:
    """
    Movie Night has a Discord URL Mapping for kodik.info. Rebuild the
    compatible player URL on that mapped host while preserving its player
    id/hash/quality path and query parameters.
    """
    try:
        parsed = urlparse(normalize_player_url(url))

        if not source_is_kodik(url):
            return None

        result = f"https://kodik.info{parsed.path}"

        if parsed.query:
            result += f"?{parsed.query}"

        return result
    except Exception:
        return None


def get_year(anime: object) -> int | None:
    raw = getattr(anime, "raw_json", None)

    if not isinstance(raw, dict):
        return None

    value = str(raw.get("datePublished") or "")

    match = re.match(r"(\d{4})", value)
    return int(match.group(1)) if match else None


def candidate_score(result: object, title: str, orig: str) -> float:
    result_title = getattr(result, "title", "")
    return max(
        similarity(result_title, title),
        similarity(result_title, orig),
    )


def collect_search_results(extractor: object, title: str, orig: str) -> list:
    queries = []

    for value in (title, orig):
        value = str(value or "").strip()
        if value and normalize(value) not in {normalize(q) for q in queries}:
            queries.append(value)

    combined = []
    seen = set()

    for query in queries:
        try:
            results = extractor.search(query)
            log("search", repr(query), "->", len(results))
        except Exception as exc:
            log("search failed", repr(query), type(exc).__name__, str(exc))
            continue

        for result in results[:12]:
            key = str(getattr(result, "url", "") or getattr(result, "title", ""))
            if not key or key in seen:
                continue
            seen.add(key)
            combined.append(result)

    combined.sort(
        key=lambda result: candidate_score(result, title, orig),
        reverse=True,
    )
    return combined


def extract_kodik_options(
    extractor: object,
    title: str,
    orig: str,
    expected_year: int | None,
) -> dict:
    candidates = collect_search_results(extractor, title, orig)

    if not candidates:
        return {
            "ok": False,
            "error": "AnimeGo ничего не нашёл по названию.",
            "options": [],
        }

    failures = []

    # Try several title matches. Some AnimeGo search results can be unavailable
    # while another result for the same title works.
    for result in candidates[:5]:
        result_title = str(getattr(result, "title", "") or "")
        score = candidate_score(result, title, orig)

        if score < 0.38:
            continue

        try:
            anime = result.get_anime()
        except Exception as exc:
            failures.append(f"{result_title}: anime: {exc}")
            log("get_anime failed", result_title, type(exc).__name__, str(exc))
            continue

        anime_year = get_year(anime)

        # Year is only a soft ranking/validation hint. AnimeGo metadata can be
        # missing because some pages are blocked while player API still works.
        if (
            expected_year
            and anime_year
            and abs(expected_year - anime_year) > 2
            and score < 0.80
        ):
            log(
                "skip year mismatch",
                result_title,
                anime_year,
                "expected",
                expected_year,
            )
            continue

        try:
            episodes = list(anime.get_episodes() or [])
        except Exception as exc:
            failures.append(f"{result_title}: episodes: {exc}")
            log("get_episodes failed", result_title, type(exc).__name__, str(exc))
            continue

        if not episodes:
            failures.append(f"{result_title}: no episodes")
            continue

        # Prefer episode 1; otherwise use the earliest available episode.
        episodes.sort(key=lambda ep: int(getattr(ep, "ordinal", 999999) or 999999))
        episode = next(
            (
                ep
                for ep in episodes
                if int(getattr(ep, "ordinal", 0) or 0) == 1
            ),
            episodes[0],
        )

        episode_number = int(getattr(episode, "ordinal", 1) or 1)

        try:
            sources = list(episode.get_sources() or [])
        except Exception as exc:
            failures.append(f"{result_title}: sources: {exc}")
            log("get_sources failed", result_title, type(exc).__name__, str(exc))
            continue

        options = []
        seen_urls = set()
        seen_names = set()

        for source in sources:
            name = str(getattr(source, "title", "") or "").strip()
            raw_url = str(getattr(source, "url", "") or "").strip()

            if not name or not raw_url:
                continue

            parsed_source = urlparse(normalize_player_url(raw_url))

            log(
                "source",
                repr(name),
                "host=",
                parsed_source.hostname or "-",
                "path=",
                parsed_source.path or "-",
                "kodik_compatible=",
                source_is_kodik(raw_url),
            )

            if not source_is_kodik(raw_url):
                continue

            url = canonical_kodik_url(raw_url)

            if not url:
                continue

            norm_url = url.rstrip("/")
            norm_name = normalize(name)

            if norm_url in seen_urls:
                continue

            # Keep differently named translations even when their URLs differ.
            # Exact duplicate names are usually the same translation duplicated
            # by AnimeGo provider markup, so prefer the first.
            if norm_name and norm_name in seen_names:
                continue

            seen_urls.add(norm_url)
            if norm_name:
                seen_names.add(norm_name)

            options.append(
                {
                    "title": name[:100],
                    "url": url,
                    "episode": episode_number,
                    "provider": "AnimeGo/Kodik",
                    "raw_host": parsed_source.hostname or "",
                }
            )

        if options:
            options.sort(key=lambda item: normalize(item["title"]))

            return {
                "ok": True,
                "matchedTitle": str(
                    getattr(anime, "title", None) or result_title or title
                ),
                "year": anime_year,
                "episode": episode_number,
                "options": options[:40],
            }

        failures.append(f"{result_title}: no Kodik sources")
        log("no Kodik sources", result_title, "sources=", len(sources))

    return {
        "ok": False,
        "error": (
            "AnimeGo нашёл тайтл, но не вернул распознаваемые Kodik-плееры для первой серии."
        ),
        "details": failures[-5:],
        "options": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", required=True)
    parser.add_argument("--orig", default="")
    parser.add_argument("--year", type=int, default=0)
    args = parser.parse_args()

    try:
        from anicli_api.source.animego import Extractor
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"anicli-api import failed: {exc}",
                    "options": [],
                },
                ensure_ascii=False,
            )
        )
        return 2

    try:
        extractor = Extractor()
        result = extract_kodik_options(
            extractor,
            args.title,
            args.orig,
            args.year or None,
        )
    except Exception as exc:
        log("fatal", type(exc).__name__, str(exc))
        result = {
            "ok": False,
            "error": f"Anime source discovery failed: {exc}",
            "options": [],
        }

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
