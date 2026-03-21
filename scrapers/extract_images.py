#!/usr/bin/env python3
"""
Extract image URLs from a web page using Scrapling.

Usage:
    python extract_images.py <url> [min_width=200] [max_images=10]

Output (stdout): JSON
    {"success": true, "url": "...", "images": [{"url": "...", "alt": "...", "width": null, "height": null, "source_page": "..."}]}

Errors go to stderr, never stdout.
"""

import json
import re
import sys
import traceback
from typing import Dict, List, Optional
from urllib.parse import urljoin


# Patterns for UI elements to ignore
IGNORE_PATTERNS = [
    r'logo', r'icon', r'avatar', r'favicon', r'sprite',
    r'button', r'badge', r'emoji', r'arrow', r'nav',
    r'banner-ad', r'advertisement', r'tracking',
    r'1x1', r'pixel', r'spacer', r'blank',
]
IGNORE_RE = re.compile('|'.join(IGNORE_PATTERNS), re.IGNORECASE)


MIN_HEIGHT = 300
MAX_ASPECT_RATIO = 2.5  # reject banners wider than 2.5:1 or taller than 1:2.5


def is_likely_artwork(src: str, alt: str) -> bool:
    """Filter out UI elements, icons, and non-artwork images."""
    combined = f"{src} {alt}"
    if IGNORE_RE.search(combined):
        return False
    if src.startswith('data:'):
        return False
    if src.endswith('.svg'):
        return False
    return True


def has_acceptable_dimensions(width: Optional[int], height: Optional[int], min_width: int) -> bool:
    """Reject images that are too small or have extreme aspect ratios (banners/strips)."""
    if width is None or height is None:
        return True  # unknown dims — let Claude Vision decide later
    if width < min_width or height < MIN_HEIGHT:
        return False
    aspect = max(width, height) / max(min(width, height), 1)
    if aspect > MAX_ASPECT_RATIO:
        return False
    return True


def find_meta_content(page, property_name: str) -> Optional[str]:
    """Find a meta tag's content by property, using Scrapling's find()."""
    el = page.find(f'meta[property="{property_name}"]')
    if el:
        return el.attrib.get('content', '') or None
    # Also try name attribute
    el = page.find(f'meta[name="{property_name}"]')
    if el:
        return el.attrib.get('content', '') or None
    return None


def extract_from_instagram(page, url: str, max_images: int) -> List[Dict]:
    """Extract images from Instagram pages — prioritize og:image."""
    images = []

    img_url = find_meta_content(page, 'og:image')
    if img_url and img_url.startswith('http'):
        width = None
        height = None
        w_str = find_meta_content(page, 'og:image:width')
        h_str = find_meta_content(page, 'og:image:height')
        if w_str and w_str.isdigit():
            width = int(w_str)
        if h_str and h_str.isdigit():
            height = int(h_str)

        images.append({
            'url': img_url,
            'alt': '',
            'width': width,
            'height': height,
            'source_page': url,
        })

    return images[:max_images]


def extract_generic(page, url: str, min_width: int, max_images: int) -> List[Dict]:
    """Extract images from a generic web page."""
    images = []
    seen_urls = set()

    # First try og:image (high quality, representative)
    og_url = find_meta_content(page, 'og:image')
    if og_url:
        if not og_url.startswith('http'):
            og_url = urljoin(url, og_url)
        if og_url not in seen_urls and is_likely_artwork(og_url, ''):
            seen_urls.add(og_url)
            images.append({
                'url': og_url,
                'alt': '',
                'width': None,
                'height': None,
                'source_page': url,
            })

    # Then extract from img tags
    for img in page.css('img'):
        if len(images) >= max_images:
            break

        src = (img.attrib.get('src', '')
               or img.attrib.get('data-src', '')
               or img.attrib.get('data-lazy-src', ''))
        if not src:
            continue

        if not src.startswith('http'):
            src = urljoin(url, src)

        if src in seen_urls:
            continue

        alt = img.attrib.get('alt', '')

        if not is_likely_artwork(src, alt):
            continue

        width = None
        height = None
        try:
            w = img.attrib.get('width', '')
            h = img.attrib.get('height', '')
            if w and w.isdigit():
                width = int(w)
            if h and h.isdigit():
                height = int(h)
        except (ValueError, TypeError):
            pass

        if not has_acceptable_dimensions(width, height, min_width):
            print(f"  Skipped {src} ({width}x{height}) — bad dimensions", file=sys.stderr)
            continue

        seen_urls.add(src)
        images.append({
            'url': src,
            'alt': alt,
            'width': width,
            'height': height,
            'source_page': url,
        })

    return images[:max_images]


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'url': '',
            'images': [],
            'error': 'Usage: extract_images.py <url> [min_width] [max_images]',
        }))
        sys.exit(1)

    url = sys.argv[1]
    min_width = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    max_images = int(sys.argv[3]) if len(sys.argv) > 3 else 10

    try:
        is_instagram = 'instagram.com' in url

        if is_instagram:
            from scrapling import StealthyFetcher
            print(f"Fetching Instagram page: {url}", file=sys.stderr)
            page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
            images = extract_from_instagram(page, url, max_images)
        else:
            from scrapling import Fetcher
            print(f"Fetching page: {url}", file=sys.stderr)
            page = Fetcher.get(url, timeout=15)
            images = extract_generic(page, url, min_width, max_images)

            # If nothing found, try stealth fetcher (for JS-heavy pages)
            if not images:
                print("No images with fast fetch, trying stealth...", file=sys.stderr)
                from scrapling import StealthyFetcher
                page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
                images = extract_generic(page, url, min_width, max_images)

        print(json.dumps({
            'success': True,
            'url': url,
            'images': images,
        }))

    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({
            'success': False,
            'url': url,
            'images': [],
            'error': str(e),
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()
