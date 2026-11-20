#!/usr/bin/env python3
"""轻航 LiteNav：零依赖的本地导航、SQLite 配置存储和服务可用性检测。"""

from __future__ import annotations

import argparse
import copy
import gzip
import ipaddress
import json
import logging
import mimetypes
import re
import socket
import sqlite3
import ssl
import threading
import time
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import formatdate, parsedate_to_datetime
from functools import lru_cache
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
MAX_BODY = 1024 * 1024
# Text files at least this large are sent gzip-compressed when the browser accepts it.
GZIP_MIN_SIZE = 1024
DEFAULT_SETTINGS = {"checkInterval": 60, "failureThreshold": 3, "timeout": 5}
LOG = logging.getLogger("litenav")


class APIError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def local_hostname(hostname: str) -> bool:
    hostname = hostname.lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith((".home", ".lan", ".local")):
        return True
    try:
        address = ipaddress.ip_address(hostname)
        return address.is_private or address.is_loopback or address.is_link_local
    except ValueError:
        return False


def normalize_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise APIError("请填写网址")
    value = value.strip()
    if len(value) > 4096 or re.search(r"[\x00-\x20\x7f]", value):
        raise APIError("网址格式不正确")
    if "://" not in value:
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", value) and not re.match(
            r"^[^/]+:\d+(?:/|$)", value
        ):
            raise APIError("仅支持 http 和 https 网址")
        candidate_host = value.split("/", 1)[0].split(":", 1)[0]
        value = ("http://" if local_hostname(candidate_host) else "https://") + value.lstrip("/")
    try:
        parts = urlsplit(value)
        hostname = parts.hostname
        _ = parts.port
        if parts.scheme.lower() not in ("http", "https") or not hostname:
            raise ValueError
        if parts.username is not None or parts.password is not None:
            raise APIError("请使用不含用户名和密码的网址")
        host = hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = "[" + host + "]"
        port = ":" + str(parts.port) if parts.port else ""
        return urlunsplit((parts.scheme.lower(), host + port, parts.path, parts.query, parts.fragment))
    except (ValueError, UnicodeError):
        raise APIError("网址格式不正确") from None


def text_field(value: object, label: str, maximum: int, default: str = "") -> str:
    if value is None:
        return default
    if not isinstance(value, str) or len(value) > maximum:
        raise APIError(label + "格式不正确")
    return value.strip()


def integer(value: object, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise APIError(label + "超出范围")
    return value


def validate_state(value: object) -> dict:
    if not isinstance(value, dict):
        raise APIError("配置必须是 JSON 对象")
    categories = value.get("categories", [])
    links = value.get("links", [])
    if not isinstance(categories, list) or not isinstance(links, list):
        raise APIError("分类和网址必须是列表")
    if len(categories) > 200 or len(links) > 5000:
        raise APIError("分类或网址数量过多")
    cleaned_categories, category_ids = [], set()
    for index, item in enumerate(categories):
        if not isinstance(item, dict):
            raise APIError("分类格式不正确")
        category_id = text_field(item.get("id"), "分类 ID", 100)
        name = text_field(item.get("name"), "分类名称", 80)
        if not category_id or not name or category_id in category_ids:
            raise APIError("分类名称和 ID 不能为空，ID 不能重复")
        category_ids.add(category_id)
        cleaned_categories.append({
            "id": category_id, "name": name,
            "icon": text_field(item.get("icon"), "分类图标", 100, "folder"),
            "column": integer(item.get("column", index % 3), "分类所在列", 0, 2),
            "order": integer(item.get("order", index), "分类顺序", 0, 100000),
        })
    cleaned_links, link_ids, urls = [], set(), set()
    for index, item in enumerate(links):
        if not isinstance(item, dict):
            raise APIError("网址格式不正确")
        link_id = text_field(item.get("id"), "网址 ID", 100)
        name = text_field(item.get("name"), "网址名称", 120)
        url = normalize_url(item.get("url"))
        if not link_id or not name or link_id in link_ids:
            raise APIError("网址名称和 ID 不能为空，ID 不能重复")
        canonical = url.rstrip("/")
        if canonical in urls:
            raise APIError("该网址已存在，请编辑已有入口")
        link_ids.add(link_id)
        urls.add(canonical)
        kind = item.get("kind", "website")
        if kind not in ("website", "service"):
            raise APIError("入口类型不正确")
        category_id = item.get("categoryId") or None
        if category_id is not None and category_id not in category_ids:
            raise APIError("网址所属分类不存在")
        if kind == "website" and category_id is None:
            raise APIError("请为网址选择分类")
        icon = text_field(item.get("icon"), "图标", 4096)
        if icon.startswith(("http:", "https:")):
            icon = normalize_url(icon)
        elif icon and not re.fullmatch(r"[a-zA-Z0-9_/-]+(?:\.svg|\.png|\.ico|\.webp)?", icon):
            raise APIError("图标格式不正确")
        cleaned = {
            "id": link_id, "name": name, "url": url, "icon": icon,
            "kind": kind, "categoryId": category_id,
            "pinned": bool(item.get("pinned", False)),
            "order": integer(item.get("order", index), "网址顺序", 0, 100000),
            "pinnedOrder": integer(item.get("pinnedOrder", item.get("order", index)), "常用顺序", 0, 100000),
            "monitorEnabled": kind == "service" and bool(item.get("monitorEnabled", False)),
        }
        if item.get("iconManual") is True:
            cleaned["iconManual"] = True
        if item.get("checkUrl"):
            cleaned["checkUrl"] = normalize_url(item["checkUrl"])
        for field, label, maximum in (
            ("description", "入口说明", 500),
            ("server", "服务器名称", 100),
            ("container", "容器名称", 100),
            ("serviceGroup", "服务分组", 80),
        ):
            if field in item:
                cleaned[field] = text_field(item[field], label, maximum)
        cleaned_links.append(cleaned)
    supplied_settings = value.get("settings", {})
    if not isinstance(supplied_settings, dict):
        raise APIError("检测设置格式不正确")
    settings = {
        "checkInterval": integer(supplied_settings.get("checkInterval", 60), "检测间隔", 10, 86400),
        "failureThreshold": integer(supplied_settings.get("failureThreshold", 3), "连续失败次数", 1, 10),
        "timeout": integer(supplied_settings.get("timeout", 5), "检测超时", 1, 30),
    }
    return {"categories": cleaned_categories, "links": cleaned_links, "settings": settings}


class Store:
    """Keep user data authoritative; shipped seeds initialize empty stores only."""

    def __init__(self, data_dir: Path | str, seed_path: Path | str | None = None):
        # Keep the existing filename so renaming the app does not reset user data.
        self.path = Path(data_dir) / "guihang.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS health (id TEXT PRIMARY KEY, document TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS link_check (id TEXT PRIMARY KEY, document TEXT NOT NULL)")
            if not db.execute("SELECT 1 FROM config WHERE id=1").fetchone():
                path = Path(seed_path) if seed_path else ROOT / "seed.json"
                initial = json.loads(path.read_text("utf-8")) if path.exists() else {
                    "categories": [], "links": [], "settings": DEFAULT_SETTINGS,
                }
                clean = validate_state(initial)
                db.execute("INSERT INTO config VALUES (1, 1, ?)", (json.dumps(clean, ensure_ascii=False),))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def state(self) -> dict:
        with self.connect() as db:
            revision, document = db.execute("SELECT revision, document FROM config WHERE id=1").fetchone()
        return {"revision": revision, **json.loads(document)}

    def save(self, value: dict) -> dict:
        cleaned = validate_state(value)
        revision = value.get("revision")
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current_revision, document = db.execute("SELECT revision,document FROM config WHERE id=1").fetchone()
            if isinstance(revision, bool) or revision != current_revision:
                raise APIError("配置已在其他页面更新，请刷新后重试", 409)
            old_links = {link["id"]: link for link in json.loads(document)["links"]}
            db.execute("UPDATE config SET revision=?,document=? WHERE id=1",
                       (current_revision + 1, json.dumps(cleaned, ensure_ascii=False)))
            live_ids = set()
            for link in cleaned["links"]:
                if link["kind"] != "service":
                    continue
                live_ids.add(link["id"])
                old = old_links.get(link["id"], {})
                signature = lambda item: (item.get("url"), item.get("checkUrl"), item.get("monitorEnabled"), item.get("kind"))
                if signature(old) != signature(link):
                    db.execute("DELETE FROM health WHERE id=?", (link["id"],))
            for (health_id,) in db.execute("SELECT id FROM health").fetchall():
                if health_id not in live_ids:
                    db.execute("DELETE FROM health WHERE id=?", (health_id,))
            # A link check describes one address: drop it when the address changes. Results of deleted
            # links stay until the next check so that undoing a deletion brings its result back.
            link_urls = {link["id"]: link["url"] for link in cleaned["links"]}
            for check_id, check_document in db.execute("SELECT id,document FROM link_check").fetchall():
                if check_id in link_urls and link_urls[check_id] != json.loads(check_document).get("url"):
                    db.execute("DELETE FROM link_check WHERE id=?", (check_id,))
        return {"revision": current_revision + 1, **cleaned}

    def health(self) -> dict:
        with self.lock, self.connect() as db:
            records = {key: json.loads(value) for key, value in db.execute("SELECT id,document FROM health")}
            links = json.loads(db.execute("SELECT document FROM config WHERE id=1").fetchone()[0])["links"]
        services = {}
        for link in links:
            if link["kind"] != "service":
                continue
            record = records.get(link["id"], {
                "status": "unknown", "latencyMs": None, "lastChecked": None,
                "consecutiveFailures": 0, "message": "尚未检测",
            })
            if not link["monitorEnabled"]:
                record = {"status": "disabled", "latencyMs": None, "lastChecked": None,
                          "consecutiveFailures": 0, "message": "未启用监控"}
            services[link["id"]] = record
        return {"services": services}

    def record_check(self, link: dict, result: dict, threshold: int):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = json.loads(db.execute("SELECT document FROM config WHERE id=1").fetchone()[0])
            live = next((entry for entry in current["links"] if entry["id"] == link["id"]), None)
            if not live or live["kind"] != "service" or not live["monitorEnabled"]:
                return
            if (live["url"], live.get("checkUrl")) != (link["url"], link.get("checkUrl")):
                return
            row = db.execute("SELECT document FROM health WHERE id=?", (link["id"],)).fetchone()
            previous = json.loads(row[0]) if row else {}
            failures = 0 if result["ok"] else previous.get("consecutiveFailures", 0) + 1
            document = {
                "status": "online" if result["ok"] else ("offline" if failures >= threshold else "degraded"),
                "latencyMs": result.get("latencyMs"),
                "lastChecked": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "consecutiveFailures": failures,
                "message": result.get("message", ""),
                "httpStatus": result.get("httpStatus"),
            }
            db.execute("INSERT INTO health(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
                       (link["id"], json.dumps(document, ensure_ascii=False)))


    def link_checks(self) -> dict:
        with self.lock, self.connect() as db:
            records = {key: json.loads(value) for key, value in db.execute("SELECT id,document FROM link_check")}
            links = json.loads(db.execute("SELECT document FROM config WHERE id=1").fetchone()[0])["links"]
        urls = {link["id"]: link["url"] for link in links if link["kind"] == "website"}
        return {key: value for key, value in records.items() if urls.get(key) == value.get("url")}

    def prune_link_checks(self):
        with self.lock, self.connect() as db:
            links = json.loads(db.execute("SELECT document FROM config WHERE id=1").fetchone()[0])["links"]
            urls = {link["id"]: link["url"] for link in links if link["kind"] == "website"}
            for check_id, check_document in db.execute("SELECT id,document FROM link_check").fetchall():
                if urls.get(check_id) != json.loads(check_document).get("url"):
                    db.execute("DELETE FROM link_check WHERE id=?", (check_id,))

    def record_link_check(self, link: dict, result: dict):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = json.loads(db.execute("SELECT document FROM config WHERE id=1").fetchone()[0])
            live = next((entry for entry in current["links"] if entry["id"] == link["id"]), None)
            if not live or live["kind"] != "website" or live["url"] != link["url"]:
                return
            document = {**result, "url": link["url"], "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            db.execute("INSERT INTO link_check(id,document) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
                       (link["id"], json.dumps(document, ensure_ascii=False)))


def probe(url: str, timeout: int = 5) -> dict:
    started = time.monotonic()
    request = Request(url, headers={"User-Agent": "LiteNav/1.0", "Accept": "*/*"}, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            status = response.status
            # Read no response body: monitor availability, not application content.
    except HTTPError as error:
        status = error.code
        error.close()
    except (OSError, URLError, ValueError):
        return {"ok": False, "latencyMs": None, "message": "连接失败或请求超时", "httpStatus": None}
    reachable = 200 <= status < 400 or status in (401, 403)
    return {
        "ok": reachable,
        "latencyMs": round((time.monotonic() - started) * 1000) if reachable else None,
        "message": ("服务可达，需登录" if status in (401, 403) else "服务可达") if reachable else "HTTP " + str(status),
        "httpStatus": status,
    }


class Monitor:
    def __init__(self, store: Store):
        self.store = store
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="service-check")
        self.inflight: set[str] = set()
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._schedule, name="service-scheduler", daemon=True)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=2)
        self.pool.shutdown(wait=True, cancel_futures=True)

    def check(self, service_id: str | None = None) -> int:
        state = self.store.state()
        services = [link for link in state["links"] if link["kind"] == "service"]
        if service_id is not None and not any(link["id"] == service_id for link in services):
            raise APIError("服务不存在", 404)
        selected = [link for link in services if link["monitorEnabled"] and (service_id is None or link["id"] == service_id)]
        queued = 0
        with self.lock:
            for link in selected:
                if link["id"] in self.inflight:
                    continue
                self.inflight.add(link["id"])
                self.pool.submit(self._run, copy.deepcopy(link), state["settings"])
                queued += 1
        return queued

    def _run(self, link: dict, settings: dict):
        try:
            result = probe(link.get("checkUrl") or link["url"], settings["timeout"])
            self.store.record_check(link, result, settings["failureThreshold"])
        except Exception:
            LOG.exception("Service check failed")
        finally:
            with self.lock:
                self.inflight.discard(link["id"])

    def _schedule(self):
        # Wake frequently enough to honor updated intervals and newly enabled services.
        while not self.stop_event.is_set():
            state = self.store.state()
            services = self.store.health()["services"]
            now = datetime.now(timezone.utc)
            for link in state["links"]:
                if link["kind"] != "service" or not link["monitorEnabled"]:
                    continue
                checked = services.get(link["id"], {}).get("lastChecked")
                if not checked or (now - datetime.fromisoformat(checked)).total_seconds() >= state["settings"]["checkInterval"]:
                    try:
                        self.check(link["id"])
                    except APIError:
                        # A service may be deleted between snapshot and scheduling.
                        continue
            self.stop_event.wait(2)


BROWSER_HEADERS = {
    # Many sites turn away unknown clients, so present an ordinary browser to keep live sites from looking broken.
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def site_host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


SHARED_SUFFIXES = {"com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "com.hk", "com.tw", "co.jp", "co.uk", "org.uk", "com.au", "co.kr"}
LOGIN_PATH = re.compile(r"(^|[/._-])(login|signin|sign-in|sso|oauth|auth|passport|account)s?([/._?-]|$)", re.I)


def base_domain(host: str) -> str:
    """Rough registrable domain: mail.google.com → google.com, www.bbc.co.uk → bbc.co.uk."""
    try:
        ipaddress.ip_address(host.strip("[]"))
        return host
    except ValueError:
        pass
    labels = host.split(".")
    size = 3 if len(labels) >= 3 and ".".join(labels[-2:]) in SHARED_SUFFIXES else 2
    return ".".join(labels[-size:])


def moved_elsewhere(url: str, final_url: str | None) -> bool:
    """A redirect counts only when it leaves the site, and not when it merely asks you to sign in."""
    if not final_url or base_domain(site_host(final_url)) == base_domain(site_host(url)):
        return False
    final = urlsplit(final_url)
    return not LOGIN_PATH.search(final.hostname or "") and not LOGIN_PATH.search(final.path)


def link_status(url: str, timeout: int = 8) -> dict:
    """Classify one website address as ok, redirected, broken, unreachable or restricted (one attempt)."""
    def fetch(method: str):
        request = Request(url, headers=BROWSER_HEADERS, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.status, response.geturl(), response.headers
        except HTTPError as error:
            try:
                return error.code, error.geturl() or url, error.headers
            finally:
                error.close()

    try:
        status, final_url, headers = fetch("HEAD")
        # Plenty of servers mishandle HEAD; only trust a non-success answer after a real GET.
        if not 200 <= status < 300:
            status, final_url, headers = fetch("GET")
    except URLError as error:
        reason = error.reason
        if isinstance(reason, socket.gaierror):
            return {"status": "broken", "httpStatus": None, "finalUrl": None, "message": "域名无法解析"}
        if isinstance(reason, ssl.SSLError):
            return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "证书无效或加密连接失败"}
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "请求超时"}
        if isinstance(reason, ConnectionRefusedError):
            return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "连接被拒绝"}
        return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "连接失败"}
    except ssl.SSLError:
        return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "证书无效或加密连接失败"}
    except (TimeoutError, socket.timeout):
        return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "请求超时"}
    except (OSError, ValueError):
        return {"status": "unreachable", "httpStatus": None, "finalUrl": None, "message": "连接失败"}

    moved = final_url if moved_elsewhere(url, final_url) else None
    if 200 <= status < 400:
        if moved:
            return {"status": "redirected", "httpStatus": status, "finalUrl": moved, "message": "已跳转到 " + site_host(moved)}
        return {"status": "ok", "httpStatus": status, "finalUrl": None, "message": "可以访问"}
    if status in (404, 410):
        return {"status": "broken", "httpStatus": status, "finalUrl": moved, "message": "页面不存在（HTTP " + str(status) + "）"}
    challenged = headers is not None and (headers.get("cf-mitigated") or "cloudflare" in (headers.get("Server") or "").lower())
    if status in (401, 403, 429) or (status == 503 and challenged):
        return {"status": "restricted", "httpStatus": status, "finalUrl": None, "message": "网站可达，但拒绝了自动访问（HTTP " + str(status) + "）"}
    return {"status": "unreachable", "httpStatus": status, "finalUrl": None, "message": "网站返回错误（HTTP " + str(status) + "）"}


def check_link(url: str, timeout: int = 8, retry_delay: float = 1.5) -> dict:
    result = link_status(url, timeout)
    if result["status"] in ("broken", "unreachable"):
        # One retry keeps a brief hiccup from labelling a site dead.
        time.sleep(retry_delay)
        result = link_status(url, timeout)
    return result


class LinkChecker:
    """Runs one manual check of website links at a time, in the background."""

    def __init__(self, store: Store, workers: int = 8):
        self.store = store
        self.workers = workers
        self.lock = threading.Lock()
        self.job = {"running": False, "total": 0, "done": 0, "startedAt": None, "finishedAt": None}
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()

    def status(self) -> dict:
        with self.lock:
            return dict(self.job)

    def start(self, ids: list | None = None) -> dict:
        if ids is not None and (not isinstance(ids, list) or not all(isinstance(item, str) for item in ids)):
            raise APIError("网址 ID 格式不正确")
        state = self.store.state()
        links = [link for link in state["links"] if link["kind"] == "website" and (ids is None or link["id"] in ids)]
        if not links:
            raise APIError("没有可检测的网址")
        with self.lock:
            if self.job["running"]:
                raise APIError("正在检测中，请等待本次检测完成", 409)
            self.job = {"running": True, "total": len(links), "done": 0,
                        "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "finishedAt": None}
            timeout = max(8, int(state["settings"]["timeout"]))
            self.store.prune_link_checks()
            self.thread = threading.Thread(target=self._run, args=(copy.deepcopy(links), timeout), name="link-check", daemon=True)
            self.thread.start()
            return dict(self.job)

    def _run(self, links: list, timeout: int):
        def one(link):
            if self.stop_event.is_set():
                return
            try:
                self.store.record_link_check(link, check_link(link["url"], timeout))
            except Exception:
                LOG.exception("Link check failed")
            finally:
                with self.lock:
                    self.job["done"] += 1

        try:
            with ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="link-check") as pool:
                list(pool.map(one, links))
        finally:
            with self.lock:
                self.job["running"] = False
                self.job["finishedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def close(self):
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)


KNOWN_SITES = {
    "github.com": ("GitHub", "github", "开发工具"), "gitlab.com": ("GitLab", "gitlab", "开发工具"),
    "developer.mozilla.org": ("MDN", "mdn", "开发工具"), "vercel.com": ("Vercel", "vercel", "开发工具"),
    "cloudflare.com": ("Cloudflare", "cloudflare", "开发工具"), "hub.docker.com": ("Docker Hub", "docker", "开发工具"),
    "npmjs.com": ("npm", "npm", "开发工具"), "stackoverflow.com": ("Stack Overflow", "stackoverflow", "开发工具"),
    "chatgpt.com": ("ChatGPT", "chatgpt", "AI 工具"), "claude.ai": ("Claude", "claude", "AI 工具"),
    "deepseek.com": ("DeepSeek", "deepseek", "AI 工具"), "gemini.google.com": ("Gemini", "gemini", "AI 工具"),
    "perplexity.ai": ("Perplexity", "perplexity", "AI 工具"), "doubao.com": ("豆包", "doubao", "AI 工具"),
    "kimi.com": ("Kimi", "kimi", "AI 工具"), "tongyi.com": ("通义", "tongyi", "AI 工具"),
    "qianwen.com": ("千问（通义）", "tongyi", "AI 工具"),
    "cursor.com": ("Cursor", "cursor", "AI 工具"), "copilot.microsoft.com": ("Copilot", "copilot", "AI 工具"),
    "copilot.com": ("Microsoft Copilot", "copilot", "AI 工具"),
    "poe.com": ("Poe", "poe", "AI 工具"), "midjourney.com": ("Midjourney", "midjourney", "AI 工具"),
    "grok.com": ("Grok", "grok", "AI 工具"),
    "notion.so": ("Notion", "notion", "效率办公"), "notion.com": ("Notion", "notion", "效率办公"),
    "figma.com": ("Figma", "figma", "效率办公"),
    "docs.qq.com": ("腾讯文档", "tencent-docs", "办公"), "kdocs.cn": ("金山文档", "kdocs", "办公"),
    "deepl.com": ("DeepL", "deepl", "办公"),
    "mail.google.com": ("Gmail", "gmail", "邮箱"), "feishu.cn": ("飞书", "feishu", "效率办公"),
    "outlook.live.com": ("Outlook", "/icons/outlook.svg", "邮箱"),
    "outlook.office.com": ("Outlook", "/icons/outlook.svg", "邮箱"),
    "outlook.office365.com": ("Outlook", "/icons/outlook.svg", "邮箱"),
    "outlook.com": ("Outlook", "/icons/outlook.svg", "邮箱"),
    "mail.163.com": ("163邮箱", "mdi-email", "邮箱"), "mail.10086.cn": ("139邮箱", "mdi-email", "办公"),
    "linear.app": ("Linear", "linear", "效率办公"), "obsidian.md": ("Obsidian", "obsidian", "效率办公"),
    "sspai.com": ("少数派", "sspai", "阅读资讯"), "zhihu.com": ("知乎", "zhihu", "阅读资讯"),
    "news.ycombinator.com": ("Hacker News", "hacker-news", "阅读资讯"), "ruanyifeng.com": ("阮一峰周刊", "ruanyifeng", "阅读资讯"),
    "bilibili.com": ("哔哩哔哩", "bilibili", "影音生活"), "youtube.com": ("YouTube", "youtube", "影音生活"),
    "spotify.com": ("Spotify", "spotify", "影音生活"), "amap.com": ("高德地图", "amap", "生活工具"),
    "douban.com": ("豆瓣", "douban", "生活工具"), "taobao.com": ("淘宝", "taobao", "购物"),
    "jd.com": ("京东", "mdi-shopping", "购物"),
    "linux.do": ("Linux.do", "linux-do", "科技社区"), "ithome.com": ("IT之家", "mdi-newspaper", "科技社区"),
    "v2ex.com": ("V2EX", "mdi-forum", "科技社区"),
    "komiic.cc": ("Komiic", "mdi-book-open-page-variant", "漫画"),
    "mangacopy.com": ("拷贝漫画", "mdi-book-open-page-variant", "漫画"),
}

CATEGORY_ALIASES = {
    "AI 工具": ("AI 工具", "AI"),
    "效率办公": ("办公", "效率办公"),
    "办公": ("办公", "效率办公", "邮箱"),
    "邮箱": ("邮箱", "效率办公"),
    "影音生活": ("影音娱乐", "影音生活"),
    "购物": ("购物", "生活工具"),
}


class MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title_parts = []
        self.base_href = ""
        self.icons = []
        self.touch_icons = []
        self.site_name = ""

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or "" for key, value in attrs}
        if tag == "title":
            self.in_title = True
        href = attrs.get("href", "").strip()
        if tag == "base" and href and not self.base_href:
            self.base_href = href
        if tag == "link" and href and not href.startswith("#"):
            rel = attrs.get("rel", "").lower().split()
            if "icon" in rel:
                self.icons.append(href)
            elif "apple-touch-icon" in rel or "apple-touch-icon-precomposed" in rel:
                self.touch_icons.append(href)
        if tag == "meta" and attrs.get("property", "").lower() == "og:site_name":
            self.site_name = attrs.get("content", "")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title and sum(map(len, self.title_parts)) < 512:
            self.title_parts.append(data)

    def icon_url(self, page_url):
        def resolve(base, href):
            try:
                target = urljoin(base, href)
                if urlsplit(target).scheme in ("http", "https"):
                    return normalize_url(target)
            except ValueError:
                pass
            return ""

        base = resolve(page_url, self.base_href) or page_url
        for href in self.icons + self.touch_icons:
            icon = resolve(base, href)
            if icon:
                return icon
        return resolve(page_url, "/favicon.ico")


def metadata(url: str, categories: list[dict], remote: bool = True) -> dict:
    url = normalize_url(url)
    hostname = urlsplit(url).hostname or ""
    match_host = hostname.removeprefix("www.")
    known = KNOWN_SITES.get(match_host)
    kind = "service" if local_hostname(hostname) else "website"
    category_name = known[2] if known else ""
    category_names = CATEGORY_ALIASES.get(category_name, (category_name,)) if known else ()
    category_id = next((item["id"] for name in category_names for item in categories if item["name"] == name), None)
    result = {
        "url": url, "name": known[0] if known else match_host,
        "icon": known[1] if known else "", "categoryId": category_id,
        "kind": kind,
    }
    # Familiar sites can be recognized immediately, without waiting for a network request.
    if known or not remote:
        return result
    # The browser may still reach the site's favicon when the server cannot read the page.
    result["icon"] = urljoin(url, "/favicon.ico")
    try:
        request = Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; LiteNav/1.0)", "Accept": "text/html"})
        with urlopen(request, timeout=4) as response:
            content_type = response.headers.get_content_type()
            if content_type not in ("text/html", "application/xhtml+xml"):
                return result
            raw = response.read(256 * 1024)
            charset = response.headers.get_content_charset() or "utf-8"
            try:
                page = raw.decode(charset, errors="replace")
            except LookupError:
                page = raw.decode("utf-8", errors="replace")
            parser = MetadataParser()
            parser.feed(page)
            name = parser.site_name or " ".join("".join(parser.title_parts).split())
            if name:
                result["name"] = name[:120]
            result["icon"] = parser.icon_url(response.url) or result["icon"]
    except HTTPError as error:
        error.close()
    except (OSError, URLError, ValueError, TimeoutError):
        pass
    return result


def compressible(mime: str) -> bool:
    return mime.startswith(("text/", "application/json", "image/svg+xml"))


def accepts_gzip(header: str | None) -> bool:
    for item in (header or "").split(","):
        coding, _, params = item.strip().partition(";")
        if coding.strip().lower() in ("gzip", "*"):
            quality = params.strip().lower().removeprefix("q=")
            try:
                return not params.strip() or float(quality) > 0
            except ValueError:
                return False
    return False


@lru_cache(maxsize=128)
def gzipped(path: str, size: int, mtime_ns: int) -> bytes:
    """One file version compressed once; size and mtime_ns key the version."""
    return gzip.compress(Path(path).read_bytes(), compresslevel=6, mtime=0)


def not_modified(headers, etag: str, mtime: float) -> bool:
    """If-None-Match decides when present (RFC 9110 §13.1.3), else If-Modified-Since."""
    tags = headers.get("If-None-Match")
    if tags is not None:
        bare = etag.removeprefix("W/")
        return any(tag.strip() == "*" or tag.strip().removeprefix("W/") == bare for tag in tags.split(","))
    since = headers.get("If-Modified-Since")
    if not since:
        return False
    try:
        return int(mtime) <= parsedate_to_datetime(since).timestamp()
    except (TypeError, ValueError, OverflowError):
        return False


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # The page loads about forty modules at once; the default backlog of 5 made
    # the system refuse connections when two tabs opened together, leaving one
    # blank.
    request_queue_size = 128

    def __init__(self, address, store: Store, public_dir: Path | str = ROOT / "public"):
        self.store = store
        self.monitor = Monitor(store)
        self.link_checker = LinkChecker(store)
        self.public_dir = Path(public_dir).resolve()
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: AppServer
    server_version = "LiteNav/1.0"
    # HEAD answers like GET without the body (uptime monitors probe with it).
    head_only = False

    def write_body(self, payload: bytes):
        if not self.head_only:
            self.wfile.write(payload)

    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.address_string(), fmt % args)

    def json_response(self, value: dict, status: int = 200):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.write_body(payload)

    def json_body(self) -> dict:
        if self.headers.get_content_type() != "application/json":
            raise APIError("请求必须使用 application/json", 415)
        if self.headers.get("Transfer-Encoding"):
            raise APIError("不支持分块请求", 400)
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            raise APIError("不允许跨站修改", 403)
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError("请求长度不正确") from None
        if not 0 <= size <= MAX_BODY:
            raise APIError("请求内容过大", 413)
        try:
            value = json.loads(self.rfile.read(size))
        except (UnicodeError, json.JSONDecodeError):
            raise APIError("JSON 格式不正确") from None
        if not isinstance(value, dict):
            raise APIError("请求内容必须是 JSON 对象")
        return value

    def do_GET(self):
        try:
            path = urlsplit(self.path).path
            if path == "/api/state":
                self.json_response(self.server.store.state())
            elif path == "/api/health":
                self.json_response(self.server.store.health())
            elif path == "/api/link-check":
                self.json_response({"job": self.server.link_checker.status(), "results": self.server.store.link_checks()})
            elif path.startswith("/api/"):
                raise APIError("接口不存在", 404)
            else:
                self.serve_static(path)
        except APIError as error:
            self.json_response({"error": str(error)}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            LOG.exception("Request failed")
            self.json_response({"error": "请求处理失败，请稍后重试"}, 500)

    def do_HEAD(self):
        self.head_only = True
        self.do_GET()

    def do_PUT(self):
        self.mutate("PUT")

    def do_POST(self):
        self.mutate("POST")

    def mutate(self, method: str):
        try:
            path = urlsplit(self.path).path
            body = self.json_body()
            if method == "PUT" and path == "/api/state":
                self.json_response(self.server.store.save(body))
            elif method == "POST" and path == "/api/metadata" and "urls" in body:
                urls = body.get("urls")
                if not isinstance(urls, list) or len(urls) > 5000:
                    raise APIError("网址列表格式不正确")
                state = self.server.store.state()
                # Batches (bookmark imports) only use the built-in site table and never fetch pages.
                items = []
                for url in urls:
                    try:
                        items.append(metadata(url, state["categories"], remote=False))
                    except APIError:
                        items.append(None)
                self.json_response({"items": items})
            elif method == "POST" and path == "/api/metadata":
                state = self.server.store.state()
                self.json_response(metadata(body.get("url"), state["categories"]))
            elif method == "POST" and path == "/api/link-check":
                job = self.server.link_checker.start(body.get("ids"))
                self.json_response({"job": job, "results": self.server.store.link_checks()}, 202)
            elif method == "POST" and path == "/api/check":
                service_id = body.get("id")
                if service_id is not None and not isinstance(service_id, str):
                    raise APIError("服务 ID 格式不正确")
                queued = self.server.monitor.check(service_id)
                self.json_response({"queued": queued}, 202)
            else:
                raise APIError("接口不存在", 404)
        except APIError as error:
            self.json_response({"error": str(error)}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            LOG.exception("Request failed")
            self.json_response({"error": "请求处理失败，请稍后重试"}, 500)

    def serve_static(self, path: str):
        relative = unquote(path).lstrip("/") or "index.html"
        target = (self.server.public_dir / relative).resolve()
        if not target.is_relative_to(self.server.public_dir) or not target.is_file():
            raise APIError("页面不存在", 404)
        stat = target.stat()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            mime = "text/javascript"
        text = compressible(mime)
        compress = text and stat.st_size >= GZIP_MIN_SIZE and accepts_gzip(self.headers.get("Accept-Encoding"))
        # The validator names one version of the file; the compressed body is a
        # different representation, so it gets its own tag.
        etag = '"%x-%x%s"' % (stat.st_size, stat.st_mtime_ns, "-gzip" if compress else "")
        fresh = not_modified(self.headers, etag, stat.st_mtime)
        if fresh:
            content = b""
        elif compress:
            content = gzipped(str(target), stat.st_size, stat.st_mtime_ns)
        else:
            content = target.read_bytes()
        self.send_response(304 if fresh else 200)
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", formatdate(stat.st_mtime, usegmt=True))
        self.send_header("Cache-Control", "no-cache" if target.suffix in (".html", ".js", ".css") else "public, max-age=86400")
        if text and stat.st_size >= GZIP_MIN_SIZE:
            self.send_header("Vary", "Accept-Encoding")
        if not fresh:
            self.send_header("Content-Type", mime + ("; charset=utf-8" if text else ""))
            self.send_header("Content-Length", str(len(content)))
            if compress:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
            self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.end_headers()
        self.write_body(content)


def main():
    parser = argparse.ArgumentParser(description="轻航 LiteNav · 个人网址与服务导航")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--data-dir", default=str(ROOT / "data"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    app = AppServer((args.host, args.port), Store(args.data_dir))
    app.monitor.start()
    print("轻航 LiteNav 已启动：http://" + args.host + ":" + str(app.server_port), flush=True)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.server_close()
        app.monitor.close()
        app.link_checker.close()


if __name__ == "__main__":
    main()
