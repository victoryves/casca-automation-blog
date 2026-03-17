#!/usr/bin/env python3
"""
Fetch and extract main content from a web page using Scrapling.

Usage:
    python fetch_page.py <url> [max_length]

    max_length: truncate content to this many characters (default: 5000)

Output (stdout): JSON
    {"success": true, "url": "...", "title": "...", "content": "...", "content_length": 1234}

Errors go to stderr, never stdout.
"""

import json
import sys
import traceback


def extract_content(page, max_length: int) -> tuple[str, str]:
    """Extract title and main content from a parsed page."""
    import re

    # Extract title
    title = ''
    title_el = page.find('title')
    if title_el:
        title = (title_el.text or title_el.get_all_text() or '').strip()

    # Try content selectors in priority order — use get_all_text() for deep text extraction
    selectors = [
        'article',
        'main',
        '[role="main"]',
        '.content',
        '.post-content',
        '.entry-content',
        '.article-body',
        '#content',
        '#main-content',
    ]

    content = ''
    for selector in selectors:
        el = page.find(selector)
        if el:
            text = (el.get_all_text() or '').strip()
            if len(text) > 100:
                content = text
                break

    # Fallback: get all text from the page
    if len(content) < 100:
        content = (page.get_all_text() or '').strip()

    # Clean up whitespace
    content = re.sub(r'\n{3,}', '\n\n', content)
    content = re.sub(r' {2,}', ' ', content)
    content = content.strip()

    # Truncate if needed
    if len(content) > max_length:
        content = content[:max_length] + '...'

    return title, content


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'Usage: fetch_page.py <url> [max_length]'}))
        sys.exit(1)

    url = sys.argv[1]
    max_length = int(sys.argv[2]) if len(sys.argv) > 2 else 5000

    try:
        # Layer 1: Try fast Fetcher first
        from scrapling import Fetcher
        page = Fetcher.get(url, timeout=15)

        title, content = extract_content(page, max_length)

        # Layer 2: If content is too short, try StealthyFetcher
        if len(content) < 200:
            print(f"Fast fetch got {len(content)} chars, trying stealth...", file=sys.stderr)
            from scrapling import StealthyFetcher
            page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
            title, content = extract_content(page, max_length)

        print(json.dumps({
            'success': True,
            'url': url,
            'title': title,
            'content': content,
            'content_length': len(content),
        }))

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({
            'success': False,
            'url': url,
            'error': str(e),
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()
