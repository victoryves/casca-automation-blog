#!/usr/bin/env python3
"""
Fetch and extract main content from a web page using multiple backends.

Backends tried in order:
1. Firecrawl API (when FIRECRAWL_API_KEY is configured)
2. Scrapling
3. Goose3
4. Crawl4AI

Usage:
    python fetch_page.py <url> [max_length]

Output (stdout): JSON
    {
      "success": true,
      "url": "...",
      "final_url": "...",
      "title": "...",
      "content": "...",
      "content_length": 1234,
      "extractor": "scrapling"
    }

Errors go to stderr, never stdout.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import traceback
import urllib.error
import urllib.request


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)


def normalize_text(value: str, max_length: int) -> str:
    value = re.sub(r"\n{3,}", "\n\n", value)
    value = re.sub(r"[ \t]{2,}", " ", value)
    value = value.strip()
    if len(value) > max_length:
      value = value[:max_length].rstrip() + "..."
    return value


def strip_html(value: str) -> str:
    value = re.sub(r"<script[\s\S]*?</script>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"<style[\s\S]*?</style>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"&nbsp;", " ", value)
    value = re.sub(r"&amp;", "&", value)
    value = re.sub(r"&quot;", '"', value)
    value = re.sub(r"&#39;", "'", value)
    return re.sub(r"\s+", " ", value).strip()


def choose_best_text(chunks: list[str]) -> str:
    cleaned = [chunk.strip() for chunk in chunks if chunk and chunk.strip()]
    if not cleaned:
        return ""
    cleaned.sort(key=len, reverse=True)
    return cleaned[0]


def result_payload(url: str, title: str, content: str, extractor: str, final_url: str | None = None) -> dict:
    return {
        "success": True,
        "url": url,
        "final_url": final_url or url,
        "title": title.strip(),
        "content": content,
        "content_length": len(content),
        "extractor": extractor,
    }


def try_firecrawl(url: str, max_length: int) -> dict | None:
    api_key = os.getenv("FIRECRAWL_API_KEY")
    if not api_key:
        return None

    payload = json.dumps(
        {
            "url": url,
            "onlyMainContent": True,
            "formats": ["markdown", "html"],
            "removeBase64Images": True,
            "blockAds": True,
            "timeout": 30000,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.firecrawl.dev/v1/scrape",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            raw = response.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        print(f"[firecrawl] HTTP {exc.code}", file=sys.stderr)
        return None
    except Exception as exc:
        print(f"[firecrawl] failed: {exc}", file=sys.stderr)
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print("[firecrawl] invalid JSON response", file=sys.stderr)
        return None

    if not data.get("success"):
        return None

    scraped = data.get("data") or {}
    markdown = scraped.get("markdown") or ""
    html = scraped.get("html") or ""
    metadata = scraped.get("metadata") or {}
    title = metadata.get("title") or ""
    final_url = metadata.get("sourceURL") or url
    content = normalize_text(markdown or strip_html(html), max_length)

    if len(content) < 200:
        return None

    return result_payload(url, title, content, "firecrawl", final_url)


def extract_content_from_scrapling(page, max_length: int) -> tuple[str, str]:
    selectors = [
        "article",
        "main",
        '[role="main"]',
        ".content",
        ".post-content",
        ".entry-content",
        ".article-body",
        "#content",
        "#main-content",
    ]

    title = ""
    title_el = page.find("title")
    if title_el:
        title = (title_el.text or title_el.get_all_text() or "").strip()

    content = ""
    for selector in selectors:
        el = page.find(selector)
        if el:
            text = (el.get_all_text() or "").strip()
            if len(text) > 180:
                content = text
                break

    if len(content) < 180:
        content = (page.get_all_text() or "").strip()

    return title, normalize_text(content, max_length)


def try_scrapling(url: str, max_length: int) -> dict | None:
    try:
        from scrapling import Fetcher
    except Exception:
        return None

    try:
        page = Fetcher.get(url, timeout=20)
        title, content = extract_content_from_scrapling(page, max_length)
        if len(content) < 200:
            try:
                from scrapling import StealthyFetcher

                page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
                title, content = extract_content_from_scrapling(page, max_length)
            except Exception as exc:
                print(f"[scrapling] stealth fallback failed: {exc}", file=sys.stderr)

        if len(content) < 200:
            return None

        return result_payload(url, title, content, "scrapling", getattr(page, "url", url))
    except Exception as exc:
        print(f"[scrapling] failed: {exc}", file=sys.stderr)
        return None


def try_goose(url: str, max_length: int) -> dict | None:
    try:
        from goose3 import Goose
    except Exception:
        return None

    goose = None
    try:
        goose = Goose({"browser_user_agent": USER_AGENT})
        article = goose.extract(url=url)
        title = (article.title or "").strip()
        candidates = [
            article.cleaned_text or "",
            article.meta_description or "",
            article.meta_lang or "",
        ]
        content = normalize_text(choose_best_text(candidates), max_length)
        if len(content) < 200:
            return None
        return result_payload(url, title, content, "goose3", getattr(article, "final_url", url) or url)
    except Exception as exc:
        print(f"[goose3] failed: {exc}", file=sys.stderr)
        return None
    finally:
        if goose is not None:
            try:
                goose.close()
            except Exception:
                pass


async def try_crawl4ai_async(url: str, max_length: int) -> dict | None:
    try:
        from crawl4ai import AsyncWebCrawler
    except Exception:
        return None

    try:
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url)
    except Exception as exc:
        print(f"[crawl4ai] failed: {exc}", file=sys.stderr)
        return None

    if not result:
        return None

    title = getattr(result, "title", "") or ""
    markdown_obj = getattr(result, "markdown_v2", None)
    markdown = ""
    if isinstance(markdown_obj, str):
        markdown = markdown_obj
    elif markdown_obj is not None:
        markdown = getattr(markdown_obj, "raw_markdown", "") or getattr(markdown_obj, "markdown", "") or ""

    content = normalize_text(
        choose_best_text(
            [
                markdown,
                getattr(result, "markdown", "") or "",
                strip_html(getattr(result, "html", "") or ""),
                getattr(result, "cleaned_html", "") or "",
            ]
        ),
        max_length,
    )

    if len(content) < 200:
        return None

    final_url = getattr(result, "url", "") or url
    return result_payload(url, title, content, "crawl4ai", final_url)


def try_crawl4ai(url: str, max_length: int) -> dict | None:
    try:
        return asyncio.run(try_crawl4ai_async(url, max_length))
    except Exception as exc:
        print(f"[crawl4ai] async runner failed: {exc}", file=sys.stderr)
        return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: fetch_page.py <url> [max_length]"}))
        sys.exit(1)

    url = sys.argv[1]
    max_length = int(sys.argv[2]) if len(sys.argv) > 2 else 5000

    try:
        extractors = [try_firecrawl, try_scrapling, try_goose, try_crawl4ai]

        for extractor in extractors:
            result = extractor(url, max_length)
            if result:
                print(json.dumps(result))
                return

        print(
            json.dumps(
                {
                    "success": False,
                    "url": url,
                    "final_url": url,
                    "error": "No scraper backend could extract enough content",
                }
            )
        )
        sys.exit(1)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(
            json.dumps(
                {
                    "success": False,
                    "url": url,
                    "final_url": url,
                    "error": str(exc),
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
