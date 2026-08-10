#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from urllib.parse import urlparse

HELPER_VERSION = "9.27"


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


def normalize_player_url(url: object) -> str:
    raw = str(url or "").strip()
    if raw.startswith("//"):
        raw = f"https:{raw}"
    elif raw.startswith("http://"):
        raw = f"https://{raw[len('http://') :]}"
    return raw


def source_is_kodik(url: object) -> bool:
    try:
        parsed = urlparse(normalize_player_url(url))
        host = (parsed.hostname or "").lower()
        parts = [part for part in (parsed.path or "").split("/") if part]

        if parsed.scheme != "https":
            return False
        if host not in {"kodikplayer.com", "kodik.info"}:
            return False
        if len(parts) < 4:
            return False

        player_type, numeric_id, player_hash, quality = parts[:4]
        if player_type.lower() not in {
            "seria", "serial", "season", "video", "film", "episode", "uv"
        }:
            return False
        if not numeric_id.isdigit() or not player_hash:
            return False
        return bool(re.fullmatch(r"\d{3,4}p", quality, flags=re.IGNORECASE))
    except Exception:
        return False


def canonical_kodik_url(url: object) -> str | None:
    try:
        raw = normalize_player_url(url)
        parsed = urlparse(raw)
        if not source_is_kodik(raw):
            return None
        result = f"https://{(parsed.hostname or '').lower()}{parsed.path}"
        if parsed.query:
            result += f"?{parsed.query}"
        return result
    except Exception:
        return None


def exact_search_result(extractor: object, title: str, anime_url: str | None):
    title = str(title or "").strip()
    anime_url = str(anime_url or "").strip()

    if anime_url:
        try:
            for result in extractor.search(title):
                if str(getattr(result, "url", "")) == anime_url:
                    return result
        except Exception as exc:
            log("exact re-search failed", type(exc).__name__, str(exc))

        # The result originally came from this same AnimeGo extractor. Rebuild
        # its Search object so later steps stay pinned to the exact season/film
        # selected by the user instead of fuzzy-searching again.
        try:
            from anicli_api.source.animego import Search
            return Search(
                title=title or "Anime",
                thumbnail="",
                url=anime_url,
                **extractor._kwargs_http,
            )
        except Exception as exc:
            log("exact Search rebuild failed", type(exc).__name__, str(exc))

    results = extractor.search(title)
    return results[0] if results else None


def episode_numbers(anime: object) -> tuple[list, list[int]]:
    episodes = list(anime.get_episodes() or [])
    episodes.sort(key=lambda ep: int(getattr(ep, "ordinal", 999999) or 999999))
    numbers = []
    for ep in episodes:
        value = int(getattr(ep, "ordinal", 0) or 0)
        if value > 0 and value not in numbers:
            numbers.append(value)
    return episodes, numbers


def kodik_sources(episode: object) -> list[dict]:
    sources = list(episode.get_sources() or [])
    options = []
    seen_urls = set()
    seen_names = set()

    for source in sources:
        name = str(getattr(source, "title", "") or "").strip()
        raw_url = str(getattr(source, "url", "") or "").strip()
        if not name or not raw_url:
            continue

        parsed_source = urlparse(normalize_player_url(raw_url))
        is_kodik = source_is_kodik(raw_url)
        log(
            "source",
            repr(name),
            "host=", parsed_source.hostname or "-",
            "path=", parsed_source.path or "-",
            "kodik_compatible=", is_kodik,
        )
        if not is_kodik:
            continue

        url = canonical_kodik_url(raw_url)
        if not url:
            continue

        norm_url = url.rstrip("/")
        norm_name = normalize(name)
        if norm_url in seen_urls or (norm_name and norm_name in seen_names):
            continue

        seen_urls.add(norm_url)
        if norm_name:
            seen_names.add(norm_name)

        options.append({
            "title": name[:100],
            "url": url,
            "provider": "AnimeGo/Kodik",
        })

    options.sort(key=lambda item: normalize(item["title"]))
    return options


def search_catalog(extractor: object, query: str) -> dict:
    query = str(query or "").strip()
    if len(query) < 2:
        return {"ok": False, "error": "Введи хотя бы 2 символа.", "results": []}

    results = extractor.search(query)
    seen = set()
    items = []

    # AnimeGo itself is now the catalogue. The URL is kept server-side after
    # the user picks a result, which pins later dub/episode lookups to that
    # exact season/movie.
    for result in results[:16]:
        title = str(getattr(result, "title", "") or "").strip()
        url = str(getattr(result, "url", "") or "").strip()
        thumbnail = str(getattr(result, "thumbnail", "") or "").strip()
        if not title or not url or url in seen:
            continue
        seen.add(url)
        items.append({
            "title": title[:120],
            "url": url,
            "thumbnail": thumbnail,
        })
        if len(items) >= 10:
            break

    return {"ok": True, "results": items}


def discover_dubs(extractor: object, title: str, anime_url: str | None) -> dict:
    result = exact_search_result(extractor, title, anime_url)
    if not result:
        return {"ok": False, "error": "AnimeGo не нашёл выбранный тайтл.", "options": []}

    anime = result.get_anime()
    episodes, numbers = episode_numbers(anime)
    if not episodes:
        return {"ok": False, "error": "У выбранного тайтла AnimeGo не вернул серии.", "options": []}

    episode = next(
        (ep for ep in episodes if int(getattr(ep, "ordinal", 0) or 0) == 1),
        episodes[0],
    )
    ep_num = int(getattr(episode, "ordinal", 1) or 1)
    options = kodik_sources(episode)
    if not options:
        return {
            "ok": False,
            "error": "AnimeGo нашёл тайтл, но не вернул Kodik-озвучки для первой доступной серии.",
            "options": [],
            "episodes": numbers,
        }

    for option in options:
        option["episode"] = ep_num

    return {
        "ok": True,
        "matchedTitle": str(getattr(anime, "title", "") or title),
        "animeUrl": str(getattr(result, "url", "") or anime_url or ""),
        "episodes": numbers,
        "episodesCount": len(numbers),
        "options": options[:40],
    }


def resolve_episode(
    extractor: object,
    title: str,
    anime_url: str,
    dub_title: str,
    episode_number: int,
) -> dict:
    result = exact_search_result(extractor, title, anime_url)
    if not result:
        return {"ok": False, "error": "AnimeGo не нашёл выбранный сезон."}

    anime = result.get_anime()
    episodes, numbers = episode_numbers(anime)
    episode = next(
        (
            ep for ep in episodes
            if int(getattr(ep, "ordinal", 0) or 0) == int(episode_number)
        ),
        None,
    )
    if not episode:
        return {
            "ok": False,
            "error": f"Серия {episode_number} отсутствует. Доступно: {numbers[:30]}",
        }

    options = kodik_sources(episode)
    if not options:
        return {"ok": False, "error": f"Для серии {episode_number} нет Kodik-источников."}

    wanted = normalize(dub_title)
    ranked = sorted(
        options,
        key=lambda item: similarity(item.get("title"), dub_title),
        reverse=True,
    )

    selected = next(
        (item for item in ranked if normalize(item.get("title")) == wanted),
        ranked[0] if ranked and similarity(ranked[0].get("title"), dub_title) >= 0.55 else None,
    )

    if not selected:
        return {
            "ok": False,
            "error": f"Озвучка «{dub_title}» не найдена для серии {episode_number}.",
            "availableDubs": [item["title"] for item in options],
        }

    return {
        "ok": True,
        "title": selected["title"],
        "url": selected["url"],
        "episode": int(episode_number),
        "episodes": numbers,
        "episodesCount": len(numbers),
    }


def main() -> int:
    log("helper version", HELPER_VERSION)

    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["search", "dubs", "episode"], default="dubs")
    parser.add_argument("--query", default="")
    parser.add_argument("--title", default="")
    parser.add_argument("--anime-url", default="")
    parser.add_argument("--dub-title", default="")
    parser.add_argument("--episode", type=int, default=1)
    args = parser.parse_args()

    try:
        from anicli_api.source.animego import Extractor
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"anicli-api import failed: {exc}"}, ensure_ascii=False))
        return 2

    try:
        extractor = Extractor()
        if args.mode == "search":
            result = search_catalog(extractor, args.query)
        elif args.mode == "episode":
            result = resolve_episode(
                extractor,
                args.title,
                args.anime_url,
                args.dub_title,
                args.episode,
            )
        else:
            result = discover_dubs(extractor, args.title, args.anime_url or None)
    except Exception as exc:
        log("fatal", type(exc).__name__, str(exc))
        result = {"ok": False, "error": f"AnimeGo helper failed: {exc}"}

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
