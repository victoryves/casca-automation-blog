#!/usr/bin/env python3
"""
Search images from Bing, DuckDuckGo, and Google using Scrapling.

Google Images uses the large-image filter (`tbs=isz:l`) and parses
original image cards from the results payload. This is inspired by:
- crawl-original-google-images
- AutoCrawler (full-resolution Google mode)
- google-arts-crawler (high-quality arts-focused sources)

Usage:
    python search_images.py <query> <engine> <limit>

    engine: bing | duckduckgo | google | all
    limit: max number of images to return

Output (stdout): JSON
    {"success": true, "engine": "...", "images": [{"url": "...", "caption": "...", "source_page": "..."}]}

Errors go to stderr, never stdout.
"""

import json
import sys
import traceback
from urllib.parse import quote_plus


def decode_google_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except Exception:
        return (
            value.replace('\\u003d', '=')
            .replace('\\u0026', '&')
            .replace('\\u002F', '/')
            .replace('\\"', '"')
        )


def search_bing(query: str, limit: int) -> list[dict]:
    import re
    from scrapling import StealthyFetcher

    url = f"https://www.bing.com/images/search?q={query.replace(' ', '+')}&form=HDRSC2"
    page = StealthyFetcher.fetch(url, headless=True, network_idle=True)

    images = []
    html = page.html_content

    # Bing stores image data in anchor tags with class "iusc" and m attribute containing JSON
    for item in page.css('a.iusc'):
        if len(images) >= limit:
            break
        try:
            m_attr = item.attrib.get('m', '')
            if not m_attr:
                continue
            m_data = json.loads(m_attr)
            img_url = m_data.get('murl', '')
            title = m_data.get('t', '')
            source_page = m_data.get('purl', '')
            if img_url and img_url.startswith('http'):
                images.append({
                    'url': img_url,
                    'caption': title or f'Image result for {query}',
                    'source_page': source_page or '',
                })
        except (json.JSONDecodeError, KeyError):
            continue

    # Fallback: extract murl from raw HTML via regex
    if not images and html:
        for match in re.finditer(r'"murl"\s*:\s*"([^"]+)"', html):
            if len(images) >= limit:
                break
            img_url = match.group(1)
            if img_url.startswith('http'):
                images.append({
                    'url': img_url,
                    'caption': f'Image result for {query}',
                    'source_page': '',
                })

    return images


def search_duckduckgo(query: str, limit: int) -> list[dict]:
    import re
    from scrapling import StealthyFetcher

    url = f"https://duckduckgo.com/?q={query.replace(' ', '+')}&iax=images&ia=images"
    page = StealthyFetcher.fetch(url, headless=True, network_idle=True)

    images = []
    html = page.html_content

    # DDG image tiles
    for tile in page.css('.tile--img__media img, .tile--img img'):
        if len(images) >= limit:
            break
        src = tile.attrib.get('src', '') or tile.attrib.get('data-src', '')
        if src and src.startswith('http'):
            images.append({
                'url': src,
                'caption': tile.attrib.get('alt', f'Image result for {query}'),
                'source_page': '',
            })

    # Fallback: look for image data in raw HTML
    if not images and html:
        for match in re.finditer(r'"image"\s*:\s*"([^"]+)"', html):
            if len(images) >= limit:
                break
            img_url = match.group(1).replace('\\u002F', '/')
            if img_url.startswith('http'):
                images.append({
                    'url': img_url,
                    'caption': f'Image result for {query}',
                    'source_page': '',
                })

    return images


def search_google(query: str, limit: int) -> list[dict]:
    import re
    from scrapling import StealthyFetcher

    url = (
        "https://www.google.com/search?"
        f"q={quote_plus(query)}&tbm=isch&udm=2&num=50&tbs=isz:l"
    )
    page = StealthyFetcher.fetch(url, headless=True, network_idle=True)

    images = []
    html = page.html_content

    # Google large-image results contain a card payload with:
    # thumbnail, original image, dimensions, source page, and title.
    # This is much more reliable than scraping rendered <img> tags.
    card_pattern = re.compile(
        r'\[0,"(?P<id>[^"]+)",\["(?P<thumb>https?://[^"]+)",\d+,\d+\],'
        r'\["(?P<image>https?://[^"]+)",(?P<width>\d+),(?P<height>\d+)\],'
        r'null,0,"[^"]*",null,0,\{"2000":\[null,"(?P<domain>[^"]*)","(?P<size>[^"]*)"\],'
        r'"2001":\[[^\]]*\],"2003":\[null,"[^"]*","(?P<source>https?://[^"]+)","(?P<title>[^"]+)"',
        re.S,
    )

    seen = set()
    for match in card_pattern.finditer(html):
        if len(images) >= limit:
            break

        try:
            img_url = decode_google_string(match.group('image'))
            source_page = decode_google_string(match.group('source'))
            title = decode_google_string(match.group('title'))
            width = int(match.group('width'))
            height = int(match.group('height'))
        except Exception:
            continue

        if (
            not img_url.startswith('http')
            or 'google.com' in img_url
            or 'gstatic.com' in img_url
            or 'googleusercontent.com' in img_url
            or width < 400
            or height < 400
        ):
            continue

        if img_url in seen:
            continue

        seen.add(img_url)
        images.append({
            'url': img_url,
            'caption': title or f'Image result for {query}',
            'source_page': source_page or '',
        })

    # Fallback: parse script payload directly if card extraction missed.
    if not images and html:
        for match in re.finditer(r'\["(https?://[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\s*(\d+),\s*(\d+)\]', html):
            if len(images) >= limit:
                break
            img_url = match.group(1).replace('\\u003d', '=').replace('\\u0026', '&')
            width = int(match.group(2))
            height = int(match.group(3))
            if (width > 300 and height > 300
                    and 'google.com' not in img_url
                    and 'gstatic.com' not in img_url
                    and 'googleusercontent.com' not in img_url):
                images.append({
                    'url': img_url,
                    'caption': f'Image result for {query}',
                    'source_page': '',
                })

    # Last-resort fallback: direct img tags
    if not images:
        for img in page.css('img[data-src], img[data-iurl]'):
            if len(images) >= limit:
                break
            src = img.attrib.get('data-iurl', '') or img.attrib.get('data-src', '')
            if (src and src.startswith('http')
                    and 'google.com' not in src
                    and 'gstatic.com' not in src):
                images.append({
                    'url': src,
                    'caption': img.attrib.get('alt', f'Image result for {query}'),
                    'source_page': '',
                })

    return images


ENGINES = {
    'bing': search_bing,
    'google': search_google,
    'duckduckgo': search_duckduckgo,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'Usage: search_images.py <query> [engine] [limit]'}))
        sys.exit(1)

    query = sys.argv[1]
    engine = sys.argv[2] if len(sys.argv) > 2 else 'all'
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5

    try:
        all_images: list[dict] = []

        if engine == 'all':
            for eng_name, eng_func in ENGINES.items():
                if len(all_images) >= limit:
                    break
                try:
                    remaining = max(limit - len(all_images), 1)
                    results = eng_func(query, remaining)
                    all_images.extend(results)
                    print(f"[{eng_name}] Found {len(results)} images", file=sys.stderr)
                except Exception as e:
                    print(f"[{eng_name}] Failed: {e}", file=sys.stderr)
        else:
            if engine not in ENGINES:
                print(json.dumps({'success': False, 'error': f'Unknown engine: {engine}. Use: bing, duckduckgo, google, all'}))
                sys.exit(1)
            all_images = ENGINES[engine](query, limit)

        # Deduplicate by URL
        seen_urls: set[str] = set()
        unique_images: list[dict] = []
        for img in all_images:
            if img['url'] not in seen_urls:
                seen_urls.add(img['url'])
                unique_images.append(img)

        # Limit results
        unique_images = unique_images[:limit]

        print(json.dumps({
            'success': True,
            'engine': engine,
            'images': unique_images,
        }))

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({
            'success': False,
            'engine': engine,
            'error': str(e),
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()
