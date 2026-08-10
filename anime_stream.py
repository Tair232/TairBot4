#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys


def log(*parts: object) -> None:
    print("[anime_stream]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    args = parser.parse_args()

    try:
        from anicli_api.player.kodik import Kodik
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"anicli-api Kodik import failed: {exc}",
                    "videos": [],
                },
                ensure_ascii=False,
            )
        )
        return 2

    try:
        log("resolve", args.url)
        videos = Kodik().parse(args.url) or []

        result = []

        for item in videos:
            url = str(getattr(item, "url", "") or "").strip()
            quality = int(getattr(item, "quality", 0) or 0)
            media_type = str(getattr(item, "type", "") or "").strip()

            if not url:
                continue

            result.append(
                {
                    "quality": quality,
                    "type": media_type,
                    "url": url,
                }
            )

        result.sort(
            key=lambda item: int(item.get("quality") or 0),
            reverse=True,
        )

        if not result:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "Kodik не вернул HLS-ссылки.",
                        "videos": [],
                    },
                    ensure_ascii=False,
                )
            )
            return 1

        log(
            "resolved",
            ", ".join(
                f"{item['quality']}p:{item['type']}"
                for item in result
            ),
        )

        print(
            json.dumps(
                {
                    "ok": True,
                    "videos": result,
                },
                ensure_ascii=False,
            )
        )
        return 0

    except Exception as exc:
        log("fatal", type(exc).__name__, str(exc))
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"Kodik HLS resolve failed: {exc}",
                    "videos": [],
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
