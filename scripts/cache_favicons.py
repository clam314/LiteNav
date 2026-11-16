#!/usr/bin/env python3
"""Cache validated, public website favicons without contacting local services."""
import argparse
import concurrent.futures
import html.parser
import io
import ipaddress
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'public/icons/web'
IMAGE_LIMIT = 512 * 1024
HTML_LIMIT = 256 * 1024
TIMEOUT = 4
FALLBACKS = {
    'chatgpt': ('chatgpt', 'https://raw.githubusercontent.com/selfhst/icons/main/svg/chatgpt.svg'),
    'gemini': ('google-gemini', 'https://raw.githubusercontent.com/selfhst/icons/main/svg/google-gemini.svg'),
    'midjourney': ('midjourney', 'https://raw.githubusercontent.com/selfhst/icons/main/svg/midjourney.svg'),
    'npm': ('npm', 'https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/npm.svg'),
}


def public_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or '').lower().rstrip('.')
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
        return False
    if not host or '.' not in host or host.endswith(('.home', '.lan', '.local', '.localhost')):
        return False
    try:
        ipaddress.ip_address(host)
        return False  # Never contact an IP literal, including a public address.
    except ValueError:
        return True


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not public_url(newurl):
            raise ValueError('Non-public redirect rejected')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, limit, truncate=False):
    if not public_url(url):
        raise ValueError('Non-public URL rejected')
    opener = urllib.request.build_opener(PublicRedirect())
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; PersonalNavigationFaviconCache/1.0)',
        'Accept': 'image/*,text/html;q=0.8,*/*;q=0.5',
    })
    with opener.open(req, timeout=TIMEOUT) as response:
        data = response.read(limit if truncate else limit + 1)
        if len(data) > limit:
            raise ValueError('Resource exceeds size limit')
        return data, response.geturl(), response.headers.get('Content-Type', '')


class IconLinks(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.icons = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != 'link':
            return
        attrs = dict(attrs)
        rel = attrs.get('rel', '').lower().split()
        if any(word in rel for word in ('icon', 'apple-touch-icon', 'apple-touch-icon-precomposed')):
            if attrs.get('href'):
                self.icons.append(attrs['href'])


def validated_image(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return data, 'png'
    if data.startswith(b'\x00\x00\x01\x00') and len(data) > 6:
        return data, 'ico'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return data, 'webp'
    if data.lstrip().startswith((b'<svg', b'<?xml', b'<!--')):
        if any(token in data.upper() for token in (b'<!ENTITY', b'<!DOCTYPE', b'<?XML-STYLESHEET')):
            raise ValueError('SVG entity/doctype rejected')
        root = ET.fromstring(data)
        if root.tag.split('}')[-1] != 'svg':
            raise ValueError('Not an SVG root')
        for node in root.iter():
            tag = node.tag.split('}')[-1].lower()
            if tag in ('script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'set', 'animatetransform'):
                raise ValueError('Unsafe SVG element')
            for key, value in node.attrib.items():
                key = key.split('}')[-1].lower()
                if key.startswith('on'):
                    raise ValueError('SVG event handler rejected')
                if key == 'base':
                    raise ValueError('SVG base URI rejected')
                if key in ('href', 'src') and value and not value.startswith('#'):
                    raise ValueError('SVG external reference rejected')
                if re.search(r'url\(\s*[\"\']?(?!#)', value, re.I):
                    raise ValueError('SVG external paint reference rejected')
            if tag == 'style' and node.text:
                if '@import' in node.text.lower() or re.search(r'url\(\s*[\"\']?(?!#)', node.text, re.I):
                    raise ValueError('SVG external stylesheet reference rejected')
        return data, 'svg'
    if data.startswith((b'GIF87a', b'GIF89a', b'\xff\xd8\xff')):
        from PIL import Image
        output = io.BytesIO()
        image = Image.open(io.BytesIO(data))
        if image.width * image.height > 1024 * 1024:
            raise ValueError('Oversized raster image')
        image.convert('RGBA').save(output, format='PNG')
        return output.getvalue(), 'png'
    raise ValueError('Unrecognized image magic')


def cache_link(link):
    url = link['url']
    base = urllib.parse.urlsplit(url)
    origin = f'{base.scheme}://{base.netloc}'
    candidates = []
    errors = []
    try:
        page, page_url, content_type = fetch(url, HTML_LIMIT, truncate=True)
        if 'html' in content_type or page.lstrip().lower().startswith((b'<!doctype html', b'<html')):
            parser = IconLinks()
            parser.feed(page.decode('utf-8', errors='replace'))
            candidates.extend(urllib.parse.urljoin(page_url, icon) for icon in parser.icons)
    except Exception as exc:
        errors.append(type(exc).__name__)
    candidates.extend([origin + '/favicon.ico', origin + '/favicon.png', origin + '/apple-touch-icon.png'])
    seen = set()
    for candidate in candidates[:8]:
        if candidate in seen or not public_url(candidate):
            continue
        seen.add(candidate)
        try:
            data, final_url, _ = fetch(candidate, IMAGE_LIMIT)
            data, fmt = validated_image(data)
            path = DEST / f'{link["id"]}.{fmt}'
            path.write_bytes(data)
            return link['id'], {'path': f'/icons/web/{path.name}', 'source': final_url, 'format': fmt}, None
        except Exception as exc:
            errors.append(type(exc).__name__)
    return link['id'], None, ','.join(sorted(set(errors)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plan', type=Path)
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    links = [link for link in json.loads(args.plan.read_text())['links']
             if link.get('kind') == 'website' and public_url(link['url'])]
    DEST.mkdir(parents=True, exist_ok=True)
    manifest = {}
    failed = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(args.workers, 8)) as pool:
        for slug, entry, error in pool.map(cache_link, links):
            if entry:
                manifest[slug] = entry
                print(f'OK {slug}: {entry["source"]}', flush=True)
            else:
                failed[slug] = error
                print(f'MISS {slug}: {error}', flush=True)
    for slug, (asset, source) in FALLBACKS.items():
        if slug not in failed:
            continue
        try:
            data, fmt = validated_image((ROOT / 'public/icons' / f'{asset}.svg').read_bytes())
            path = DEST / f'{slug}.{fmt}'
            path.write_bytes(data)
            manifest[slug] = {'path': f'/icons/web/{path.name}', 'source': source, 'format': fmt}
            del failed[slug]
            print(f'BUNDLED {slug}: {source}', flush=True)
        except (OSError, ValueError, ET.ParseError):
            pass
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'success': len(manifest), 'failed': failed}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
