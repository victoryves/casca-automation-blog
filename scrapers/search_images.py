#!/usr/bin/env python3
"""
Search images from Google Images, Bing, and DuckDuckGo with a robust
artwork-oriented Google pipeline.

The Google flow is intentionally prioritized and inspired by:
- crawl-original-google-images
- AutoCrawler
- google-arts-crawler

Usage:
    python search_images.py <query> <engine> <limit> [options_json]

    engine: bing | duckduckgo | google | all
    options_json example:
      {"siteFilters":["artsandculture.google.com","itaucultural.org.br"],"artworkOnly":true}
"""

from __future__ import annotations

import json
import re
import sys
import traceback
from typing import Iterable
from urllib.parse import quote_plus, urlparse


DEFAULT_GOOGLE_SITE_FILTERS = [
    "artsandculture.google.com",
    "enciclopedia.itaucultural.org.br",
    "itaucultural.org.br",
    "escritoriodearte.com",
    "pinacoteca.org.br",
    "masp.org.br",
    "museudeartedorio.org.br",
    "mam.org.br",
    "mamba.org.br",
    "museuafrobrasil.org.br",
    "inhotim.org.br",
    "ocula.com",
    "artbasel.com",
    "visualaids.org",
    "dailyartfair.com",
    "mutualart.com",
]

BLOCKED_HOST_SNIPPETS = (
    "google.com",
    "gstatic.com",
    "googleusercontent.com",
    "ytimg.com",
    "pinimg.com",
    "facebook.com",
    "instagram.com",
)


def decode_google_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except Exception:
        return (
            value.replace("\\u003d", "=")
            .replace("\\u0026", "&")
            .replace("\\u002F", "/")
            .replace("\\/", "/")
            .replace('\\"', '"')
        )


def normalize_source_domain(value: str) -> str:
    if not value:
        return ""

    try:
        hostname = urlparse(value).hostname or ""
    except Exception:
        hostname = ""

    return hostname.lower().removeprefix("www.")


def build_google_queries(query: str, site_filters: list[str], artwork_only: bool) -> list[str]:
    base_terms = [
        query.strip(),
        f"{query.strip()} obra",
    ]
    if artwork_only:
        base_terms = [
            f'{term} -poster -flyer -catalog -exhibition -artist -portrait -interview -opening -installation'
            for term in base_terms
        ]

    queries: list[str] = []
    for term in base_terms:
        queries.append(term)
        for site_filter in site_filters[:3]:
            queries.append(f"{term} site:{site_filter}")

    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in queries:
        normalized = candidate.strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(candidate.strip())
    return deduped


def is_candidate_image_url(url: str, width: int = 0, height: int = 0) -> bool:
    normalized = url.lower()
    if not normalized.startswith("http"):
        return False
    if any(blocked in normalized for blocked in BLOCKED_HOST_SNIPPETS):
        return False
    if width and width < 350:
        return False
    if height and height < 350:
        return False
    return True


def score_google_candidate(candidate: dict, site_filters: list[str]) -> int:
    score = 0
    source_page = candidate.get("source_page", "")
    source_domain = normalize_source_domain(source_page)
    caption = (candidate.get("caption") or "").lower()
    url = (candidate.get("url") or "").lower()
    width = int(candidate.get("width") or 0)
    height = int(candidate.get("height") or 0)

    if width >= 1200 or height >= 1200:
        score += 5
    elif width >= 800 or height >= 800:
        score += 3

    if source_domain:
        score += 2

    if any(source_domain == site or source_domain.endswith(f".{site}") for site in site_filters):
        score += 8

    if any(signal in caption for signal in ("artwork", "painting", "drawing", "print", "woodcut", "gravura", "obra")):
        score += 3

    if any(signal in url for signal in ("artwork", "painting", "drawing", "obra", "gravura", "quadro")):
        score += 2

    if any(bad in caption for bad in ("poster", "flyer", "interview", "artist portrait", "opening", "exhibition")):
        score -= 6

    return score


def build_result(url: str, caption: str, source_page: str, width: int = 0, height: int = 0, engine: str = "", pipeline: str = "") -> dict:
    return {
        "url": url,
        "caption": caption,
        "source_page": source_page,
        "width": width or None,
        "height": height or None,
        "source_domain": normalize_source_domain(source_page),
        "engine": engine,
        "pipeline": pipeline,
    }


def iter_google_card_matches(html: str) -> Iterable[dict]:
    card_patterns = [
        re.compile(
            r'\[0,"(?P<id>[^"]+)",\["(?P<thumb>https?://[^"]+)",\d+,\d+\],'
            r'\["(?P<image>https?://[^"]+)",(?P<width>\d+),(?P<height>\d+)\],'
            r'null,0,"[^"]*",null,0,\{"2000":\[null,"(?P<domain>[^"]*)","(?P<size>[^"]*)"\],'
            r'"2001":\[[^\]]*\],"2003":\[null,"[^"]*","(?P<source>https?://[^"]+)","(?P<title>[^"]+)"',
            re.S,
        ),
        re.compile(
            r'"ou":"(?P<image>https?://[^"]+?)","ow":(?P<width>\d+),"oh":(?P<height>\d+),'
            r'.{0,400}?"ru":"(?P<source>https?://[^"]+?)".{0,200}?"pt":"(?P<title>[^"]+)"',
            re.S,
        ),
    ]

    for pattern in card_patterns:
        for match in pattern.finditer(html):
            try:
                image = decode_google_string(match.group("image"))
                source = decode_google_string(match.group("source"))
                title = decode_google_string(match.group("title"))
                width = int(match.group("width"))
                height = int(match.group("height"))
            except Exception:
                continue

            if not is_candidate_image_url(image, width, height):
                continue

            yield build_result(
                image,
                title or "Google Images result",
                source,
                width,
                height,
                engine="google",
                pipeline="google-dedicated",
            )


def iter_google_fallback_matches(html: str) -> Iterable[dict]:
    patterns = [
        re.compile(
            r'\["(?P<image>https?://[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\s*(?P<width>\d+),\s*(?P<height>\d+)\]',
            re.I,
        ),
        re.compile(r'"ou":"(?P<image>https?://[^"]+)"', re.I),
    ]

    for pattern in patterns:
        for match in pattern.finditer(html):
            image = decode_google_string(match.group("image"))
            width = int(match.groupdict().get("width") or 0)
            height = int(match.groupdict().get("height") or 0)
            if not is_candidate_image_url(image, width, height):
                continue
            yield build_result(
                image,
                "Google Images result",
                "",
                width,
                height,
                engine="google",
                pipeline="google-fallback",
            )


def search_google(query: str, limit: int, options: dict | None = None) -> list[dict]:
    from scrapling import StealthyFetcher

    options = options or {}
    site_filters = list(dict.fromkeys((options.get("siteFilters") or []) + DEFAULT_GOOGLE_SITE_FILTERS))
    artwork_only = bool(options.get("artworkOnly", True))
    queries = build_google_queries(query, site_filters, artwork_only)

    images: list[dict] = []
    seen_urls: set[str] = set()

    for variant in queries[:10]:
        if len(images) >= limit * 3:
            break

        url = (
            "https://www.google.com/search?"
            f"q={quote_plus(variant)}&tbm=isch&udm=2&num=100&tbs=isz:l"
        )

        try:
            page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
            html = page.html_content or ""
        except Exception as exc:
            print(f"[google] Failed query variant '{variant}': {exc}", file=sys.stderr)
            continue

        lowered_html = html.lower()
        if "sorry/index" in lowered_html or "unusual traffic" in lowered_html:
            print("[google] Rate limited by Google Images, stopping dedicated stage early", file=sys.stderr)
            break

        for candidate in list(iter_google_card_matches(html)) + list(iter_google_fallback_matches(html)):
            key = candidate["url"]
            if key in seen_urls:
                continue
            seen_urls.add(key)
            images.append(candidate)

    ranked = sorted(images, key=lambda item: score_google_candidate(item, site_filters), reverse=True)
    return ranked[:limit]


def search_bing(query: str, limit: int, options: dict | None = None) -> list[dict]:
    from scrapling import StealthyFetcher

    _ = options
    url = f"https://www.bing.com/images/search?q={quote_plus(query)}&form=HDRSC2"
    page = StealthyFetcher.fetch(url, headless=True, network_idle=True)

    images = []
    for item in page.css("a.iusc"):
        if len(images) >= limit:
            break
        try:
            m_data = json.loads(item.attrib.get("m", ""))
        except Exception:
            continue
        img_url = m_data.get("murl", "")
        source_page = m_data.get("purl", "")
        width = int(m_data.get("m", 0) or 0)
        height = int(m_data.get("h", 0) or 0)
        if not is_candidate_image_url(img_url, width, height):
            continue
        images.append(
            build_result(
                img_url,
                m_data.get("t", "") or f"Image result for {query}",
                source_page,
                width,
                height,
                engine="bing",
                pipeline="bing",
            )
        )

    return images


def search_duckduckgo(query: str, limit: int, options: dict | None = None) -> list[dict]:
    from scrapling import StealthyFetcher

    _ = options
    url = f"https://duckduckgo.com/?q={quote_plus(query)}&iax=images&ia=images"
    page = StealthyFetcher.fetch(url, headless=True, network_idle=True)

    images = []
    for tile in page.css(".tile--img__media img, .tile--img img"):
        if len(images) >= limit:
            break
        src = tile.attrib.get("src", "") or tile.attrib.get("data-src", "")
        if not is_candidate_image_url(src):
            continue
        images.append(
            build_result(
                src,
                tile.attrib.get("alt", f"Image result for {query}"),
                "",
                engine="duckduckgo",
                pipeline="duckduckgo",
            )
        )

    return images


ENGINES = {
    "bing": search_bing,
    "google": search_google,
    "duckduckgo": search_duckduckgo,
}


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: search_images.py <query> [engine] [limit] [options_json]"}))
        sys.exit(1)

    query = sys.argv[1]
    engine = sys.argv[2] if len(sys.argv) > 2 else "all"
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    try:
        options = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {}
    except Exception:
        options = {}

    try:
        all_images: list[dict] = []

        if engine == "all":
            # Google first because it is the dedicated artwork pipeline.
            engine_order = [("google", ENGINES["google"]), ("bing", ENGINES["bing"]), ("duckduckgo", ENGINES["duckduckgo"])]
            for eng_name, eng_func in engine_order:
                if len(all_images) >= limit:
                    break
                remaining = max(limit - len(all_images), 1)
                try:
                    results = eng_func(query, remaining * (2 if eng_name == "google" else 1), options)
                    all_images.extend(results)
                    print(f"[{eng_name}] Found {len(results)} images", file=sys.stderr)
                except Exception as exc:
                    print(f"[{eng_name}] Failed: {exc}", file=sys.stderr)
        else:
            if engine not in ENGINES:
                print(json.dumps({"success": False, "error": f"Unknown engine: {engine}. Use: bing, duckduckgo, google, all"}))
                sys.exit(1)
            all_images = ENGINES[engine](query, limit, options)

        seen_urls: set[str] = set()
        unique_images: list[dict] = []
        for img in all_images:
            if img["url"] in seen_urls:
                continue
            seen_urls.add(img["url"])
            unique_images.append(img)

        print(
            json.dumps(
                {
                    "success": True,
                    "engine": engine,
                    "images": unique_images[:limit],
                }
            )
        )
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(
            json.dumps(
                {
                    "success": False,
                    "engine": engine,
                    "error": str(exc),
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
