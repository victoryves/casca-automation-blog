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
from urllib.parse import urlparse


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
MIN_BROWSER_RENDER_BYTES = 1024 * 1024
USE_4K_RENDER = '--use-4k-render' in sys.argv or 'USE_4K_RENDER' in __import__('os').environ
FULLSCREEN_HINTS = [
    'zoom', 'full', 'fullscreen', 'ampliar', 'expand', 'maximizar',
    'detalhe', 'full-screen', 'full screen', 'original'
]


def is_relative_navigation_noise(src: str) -> bool:
    lowered = src.lower().strip()
    return bool(re.fullmatch(r'/[a-z-]+', lowered))


def is_filetype_noise(src: str) -> bool:
    lowered = src.lower().split('?', 1)[0]
    if lowered.endswith('.svg') or lowered.endswith('.ico'):
        return True
    if lowered.endswith('.png') and any(token in lowered for token in ['favicon', 'icon', 'logo', 'apple-touch', 'android-chrome']):
        return True
    return False


def is_likely_artwork(src: str, alt: str) -> bool:
    """Filter out UI elements, icons, and non-artwork images."""
    combined = f"{src} {alt}"
    if IGNORE_RE.search(combined):
        return False
    if is_relative_navigation_noise(src):
        return False
    if is_filetype_noise(src):
        return False
    if src.startswith('data:'):
        return False
    if src.endswith('.svg'):
        return False
    return True


def is_gstatic_noise(src: str) -> bool:
    lowered = src.lower()
    return (
        'gstatic.com' in lowered and
        any(token in lowered for token in ['favicon', 'apple-touch-icon', 'android-chrome', 'icon'])
    )


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

        if is_gstatic_noise(src):
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


def guess_bytes_from_url(src: str) -> int:
    lowered = src.lower()
    if '=s4000' in lowered or '=s0' in lowered:
        return 2 * 1024 * 1024
    if any(token in lowered for token in ['/original/', '/full/', '/large/']):
        return 2 * 1024 * 1024
    return 0


def build_attr_candidates(node) -> List[str]:
    attrs = [
        'src', 'data-src', 'data-lazy-src', 'data-original', 'data-full',
        'data-full-res', 'data-fullres', 'data-zoom', 'href'
    ]
    values = []
    for attr in attrs:
        value = node.attrib.get(attr, '')
        if value:
            values.append(value)
    return values


def looks_like_large_asset_reference(src: str) -> bool:
    lowered = src.lower()
    return (
        any(token in lowered for token in ['data-original', 'data-full', 'data-full-res', 'data-fullres', 'data-zoom']) or
        any(token in lowered for token in ['/original/', '/full/', '/large/', '=s4000', '=s0', 'googleusercontent', 'midias-publicas', 'iiif', 'download'])
    )


def maybe_force_google_arts_high_res(src: str) -> str:
    lowered = src.lower()
    if 'lh3.googleusercontent.com' in lowered:
        if '=s' in src:
            return re.sub(r'=s\d+\b', '=s4000', src)
        if '=w' in src:
            return re.sub(r'=w\d+\b', '=s4000', src)
        joiner = '&' if '?' in src else '='
        return f"{src}{joiner}s4000"
    return src


def expand_high_res_candidates(src: str) -> List[str]:
    normalized = maybe_force_google_arts_high_res(src)
    expanded = [normalized]
    lowered = normalized.lower()

    replacements = [
        ('/thumb/', '/original/'),
        ('/thumbs/', '/original/'),
        ('/thumbnail/', '/original/'),
        ('/thumbnails/', '/original/'),
        ('/small/', '/large/'),
        ('/preview/', '/full/'),
        ('_thumb', '_original'),
        ('-thumb', '-original'),
        ('_small', '_large'),
        ('-small', '-large'),
        ('_preview', '_full'),
        ('-preview', '-full'),
    ]

    for old, new in replacements:
      if old in lowered:
        expanded.append(normalized.replace(old, new))

    if 'itaucultural.org.br' in lowered or 'midias-publicas.enciclopedia.itaucultural.org.br' in lowered:
        expanded.append(normalized.replace('/thumbnails/', '/original/'))
        expanded.append(normalized.replace('/thumbnail/', '/original/'))
        expanded.append(normalized.replace('-t.', '-o.'))
        expanded.append(normalized.replace('_t.', '_o.'))
        expanded.append(normalized.replace('/small/', '/fundo_'))
        expanded.append(normalized.replace('/preview/', '/original/'))

    deduped = []
    seen = set()
    for candidate in expanded:
        if candidate and candidate not in seen:
            seen.add(candidate)
            deduped.append(candidate)
    return deduped


def node_text(node) -> str:
    try:
        return ' '.join(
            filter(
                None,
                [
                    node.text or '',
                    node.attrib.get('aria-label', ''),
                    node.attrib.get('title', ''),
                    node.attrib.get('alt', ''),
                    node.attrib.get('class', ''),
                ],
            )
        )
    except Exception:
        return ''


def trigger_fullscreen_if_available(page) -> None:
    selectors = ['a', 'button', '[role="button"]']
    for selector in selectors:
        try:
            nodes = page.css(selector)
        except Exception:
            nodes = []

        for node in nodes:
            label = node_text(node).lower()
            if not any(hint in label for hint in FULLSCREEN_HINTS):
                continue
            try:
                if hasattr(node, 'click'):
                    node.click()
                    return
            except Exception:
                continue


def screenshot_candidate_for_artwork(node, url: str) -> Optional[Dict]:
    try:
        screenshot = node.screenshot()
    except Exception:
        return None

    if not screenshot:
        return None

    try:
        width = int(node.attrib.get('naturalwidth', '') or node.attrib.get('width', '') or 0) or 2160
        height = int(node.attrib.get('naturalheight', '') or node.attrib.get('height', '') or 0) or 2160
    except Exception:
        width = 2160
        height = 2160

    if max(width, height) < 1200:
        width = 2160
        height = 2160

    return {
        'url': f"data:image/png;base64,{screenshot}",
        'alt': node.attrib.get('alt', '') or node.attrib.get('title', '') or 'fullscreen-capture',
        'width': width,
        'height': height,
        'source_page': url,
    }


def extract_rendered_high_res(page, url: str, min_width: int, max_images: int) -> List[Dict]:
    images = []
    seen_urls = set()

    selectors = [
        'img',
        '[data-original]',
        '[data-full]',
        '[data-full-res]',
        '[data-fullres]',
        '[data-zoom]',
        'a[href]'
    ]

    for selector in selectors:
        try:
            nodes = page.css(selector)
        except Exception:
            nodes = []

        for node in nodes:
            if len(images) >= max_images:
                return images

            if USE_4K_RENDER and len(images) < max_images:
                capture = screenshot_candidate_for_artwork(node, url)
                if capture and has_acceptable_dimensions(capture['width'], capture['height'], max(min_width, 1200)):
                    images.append(capture)
                    if len(images) >= max_images:
                        return images

            for raw_src in build_attr_candidates(node):
                src = raw_src.strip()
                if not src:
                    continue
                if is_relative_navigation_noise(src) or is_filetype_noise(src):
                    continue
                if not src.startswith('http'):
                    if raw_src == src and not looks_like_large_asset_reference(src):
                        continue
                    src = urljoin(url, src)
                alt = node.attrib.get('alt', '') or node.attrib.get('title', '')
                for candidate_src in expand_high_res_candidates(src):
                    if candidate_src in seen_urls or is_gstatic_noise(candidate_src):
                        continue
                    if not is_likely_artwork(candidate_src, alt):
                        continue

                    width = None
                    height = None
                    try:
                      # Scrapling returns strings
                        w = node.attrib.get('width', '')
                        h = node.attrib.get('height', '')
                        natural_w = node.attrib.get('naturalwidth', '')
                        natural_h = node.attrib.get('naturalheight', '')
                        if natural_w and natural_w.isdigit():
                            width = int(natural_w)
                        elif w and w.isdigit():
                            width = int(w)
                        if natural_h and natural_h.isdigit():
                            height = int(natural_h)
                        elif h and h.isdigit():
                            height = int(h)
                    except (ValueError, TypeError):
                        pass

                    estimated_bytes = guess_bytes_from_url(candidate_src)
                    if not has_acceptable_dimensions(width, height, min_width) and estimated_bytes < MIN_BROWSER_RENDER_BYTES:
                        continue

                    seen_urls.add(candidate_src)
                    images.append({
                        'url': candidate_src,
                        'alt': alt,
                        'width': width,
                        'height': height,
                        'source_page': url,
                    })
                    break
                else:
                    continue
                break

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
        parsed = urlparse(url)
        hostname = parsed.hostname or ''
        use_browser_render = (
            'itaucultural.org.br' in hostname or
            'artsandculture.google.com' in hostname
        )

        if is_instagram:
            from scrapling import StealthyFetcher
            print(f"Fetching Instagram page: {url}", file=sys.stderr)
            page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
            images = extract_from_instagram(page, url, max_images)
        else:
            if 'gstatic.com' in hostname:
                images = []
            elif use_browser_render:
                from scrapling import StealthyFetcher
                print(f"Fetching page with browser render: {url}", file=sys.stderr)
                page = StealthyFetcher.fetch(
                    url,
                    headless=True,
                    network_idle=True,
                    google_search=False,
                    disable_resources=False,
                    page_action=lambda p: (
                        p.set_viewport_size({"width": 3840, "height": 2160}) if USE_4K_RENDER and hasattr(p, 'set_viewport_size') else None
                    ),
                )
                if USE_4K_RENDER:
                    try:
                        trigger_fullscreen_if_available(page)
                    except Exception:
                        pass
                images = extract_rendered_high_res(page, url, min_width, max_images)
                if not images:
                    images = extract_generic(page, url, min_width, max_images)
            else:
                from scrapling import Fetcher
                print(f"Fetching page: {url}", file=sys.stderr)
                page = Fetcher.get(url, timeout=15)
                images = extract_generic(page, url, min_width, max_images)

            # If nothing found, try stealth fetcher (for JS-heavy pages)
            if not images and not use_browser_render and 'gstatic.com' not in hostname:
                print("No images with fast fetch, trying stealth...", file=sys.stderr)
                from scrapling import StealthyFetcher
                page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
                images = extract_rendered_high_res(page, url, min_width, max_images)
                if not images:
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
