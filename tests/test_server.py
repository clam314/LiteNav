"""配置、监控与 HTTP API 的行为回归。"""
import copy
import json
import socket
import ssl
import tempfile
import threading
import time
import unittest
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import server


def sample():
    return {
        "categories": [
            {"id": "ai", "name": "AI 工具", "icon": "bot", "column": 0, "order": 0},
            {"id": "dev", "name": "开发工具", "icon": "code", "column": 1, "order": 1},
        ],
        "links": [
            {"id": "github", "name": "GitHub", "url": "https://github.com", "icon": "github",
             "kind": "website", "categoryId": "dev", "pinned": True, "order": 0, "monitorEnabled": False},
            {"id": "nas", "name": "NAS", "url": "http://nas.home", "icon": "server",
             "kind": "service", "categoryId": None, "pinned": True, "order": 1, "monitorEnabled": False},
        ],
        "settings": {"checkInterval": 60, "failureThreshold": 3, "timeout": 5},
    }


class DataFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.seed = self.directory / "seed.json"
        self.seed.write_text(json.dumps(sample()), "utf-8")
        self.store = server.Store(self.directory / "data", self.seed)

    def tearDown(self):
        self.tmp.cleanup()

    def enable_service(self):
        value = self.store.state()
        value["links"][1]["monitorEnabled"] = True
        return self.store.save(value)["links"][1]


class StoreCase(DataFixture):
    def test_existing_state_and_health_ignore_replaced_default_seed(self):
        service = self.enable_service()
        self.store.record_check(service, {"ok": False, "message": "测试异常"}, 1)
        state_before = self.store.state()
        health_before = self.store.health()
        self.seed.write_text((server.ROOT / "seed.json").read_text("utf-8"), "utf-8")
        reopened = server.Store(self.directory / "data", self.seed)
        self.assertEqual(reopened.state(), state_before)
        self.assertEqual(reopened.health(), health_before)

    def test_existing_state_does_not_read_invalid_replacement_seed(self):
        state_before = self.store.state()
        self.seed.write_text("not valid json", "utf-8")
        reopened = server.Store(self.directory / "data", self.seed)
        self.assertEqual(reopened.state(), state_before)

    def test_saved_config_survives_reopen(self):
        state = self.store.state()
        state["links"][0]["name"] = "我的代码"
        updated = self.store.save(state)
        reopened = server.Store(self.directory / "data", self.seed)
        self.assertEqual(reopened.state(), updated)
        self.assertEqual(updated["revision"], 2)

    def test_optional_service_metadata_survives_save_export_and_import(self):
        metadata = {
            "description": " 家庭媒体服务 ", "server": "nas-01",
            "container": "jellyfin", "serviceGroup": "媒体服务",
        }
        state = self.store.state()
        state["links"][1].update(metadata)
        saved = self.store.save(state)
        reopened = server.Store(self.directory / "data", self.seed)
        exported = json.loads(json.dumps(reopened.state(), ensure_ascii=False))
        restored = self.store.save(exported)
        for field, value in metadata.items():
            self.assertEqual(saved["links"][1][field], value.strip())
            self.assertEqual(restored["links"][1][field], value.strip())
        self.assertNotIn("description", restored["links"][0])

    def test_optional_metadata_limits_reject_import_without_changing_config(self):
        for field, maximum in (("description", 500), ("server", 100), ("container", 100), ("serviceGroup", 80)):
            with self.subTest(field=field):
                state = self.store.state()
                state["links"][1][field] = "字" * maximum
                saved = self.store.save(state)
                for invalid in ("字" * (maximum + 1), {"name": "invalid"}):
                    changed = copy.deepcopy(saved)
                    changed["links"][1][field] = invalid
                    with self.assertRaises(server.APIError):
                        self.store.save(changed)
                    self.assertEqual(self.store.state(), saved)

    def test_stale_revision_cannot_overwrite_newer_change(self):
        stale = self.store.state()
        fresh = copy.deepcopy(stale)
        fresh["links"][0]["name"] = "已更新"
        self.store.save(fresh)
        with self.assertRaises(server.APIError) as error:
            self.store.save(stale)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.state()["links"][0]["name"], "已更新")

    def test_invalid_import_does_not_replace_config(self):
        before = self.store.state()
        invalid = copy.deepcopy(before)
        invalid["links"][0]["url"] = "javascript:alert(1)"
        with self.assertRaises(server.APIError):
            self.store.save(invalid)
        self.assertEqual(self.store.state(), before)

    def test_duplicate_url_rejected(self):
        state = self.store.state()
        duplicate = copy.deepcopy(state["links"][0])
        duplicate["id"] = "another"
        duplicate["url"] += "/"
        state["links"].append(duplicate)
        with self.assertRaisesRegex(server.APIError, "已存在"):
            self.store.save(state)

    def test_demo_services_are_disabled_not_fake_online(self):
        self.assertEqual(self.store.health()["services"]["nas"]["status"], "disabled")
        monitor = server.Monitor(self.store)
        try:
            with patch("server.probe") as probe:
                self.assertEqual(monitor.check(), 0)
                probe.assert_not_called()
        finally:
            monitor.close()

    def test_failures_need_threshold_then_recovery_clears_count(self):
        link = self.enable_service()
        failure = {"ok": False, "latencyMs": None, "message": "连接失败", "httpStatus": None}
        self.store.record_check(link, failure, 3)
        self.assertEqual(self.store.health()["services"]["nas"]["status"], "degraded")
        self.store.record_check(link, failure, 3)
        self.assertEqual(self.store.health()["services"]["nas"]["consecutiveFailures"], 2)
        self.store.record_check(link, failure, 3)
        self.assertEqual(self.store.health()["services"]["nas"]["status"], "offline")
        self.store.record_check(link, {"ok": True, "latencyMs": 12, "message": "服务可达", "httpStatus": 200}, 3)
        record = self.store.health()["services"]["nas"]
        self.assertEqual(record["status"], "online")
        self.assertEqual(record["consecutiveFailures"], 0)
        self.assertEqual(record["latencyMs"], 12)

    def test_address_change_discards_stale_probe_result(self):
        old_link = self.enable_service()
        state = self.store.state()
        state["links"][1]["url"] = "http://new-nas.home"
        self.store.save(state)
        self.store.record_check(old_link, {"ok": False}, 1)
        self.assertEqual(self.store.health()["services"]["nas"]["status"], "unknown")

    def test_disabled_service_does_not_restore_old_error(self):
        link = self.enable_service()
        self.store.record_check(link, {"ok": False}, 1)
        state = self.store.state()
        state["links"][1]["monitorEnabled"] = False
        self.store.save(state)
        state = self.store.state()
        state["links"][1]["monitorEnabled"] = True
        self.store.save(state)
        self.assertEqual(self.store.health()["services"]["nas"]["status"], "unknown")

    def test_config_import_cannot_inject_monitoring_health(self):
        value = self.store.state()
        value["health"] = {"nas": {"status": "online"}}
        saved = self.store.save(value)
        self.assertNotIn("health", saved)
        self.assertEqual(self.store.health()["services"]["nas"]["status"], "disabled")

    def test_pinned_order_is_independent_of_category_order(self):
        value = self.store.state()
        value["links"][0]["pinnedOrder"] = 9
        updated = self.store.save(value)
        self.assertEqual(updated["links"][0]["pinnedOrder"], 9)
        self.assertEqual(updated["links"][0]["order"], 0)


    def test_deleted_service_does_not_stop_scheduler(self):
        self.enable_service()
        monitor = server.Monitor(self.store)
        try:
            with patch.object(monitor, "check", side_effect=server.APIError("服务不存在", 404)) as check:
                with patch.object(monitor.stop_event, "wait", side_effect=lambda _: monitor.stop_event.set()):
                    monitor._schedule()
            check.assert_called_once_with("nas")
        finally:
            monitor.close()


class DefaultSeedCase(unittest.TestCase):
    def test_fresh_install_uses_generic_public_defaults_without_services(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server.Store(directory)
            shipped = server.validate_state(json.loads((server.ROOT / "seed.json").read_text("utf-8")))
            self.assertEqual(store.state(), {"revision": 1, **shipped})
            self.assertTrue(shipped["links"])
            self.assertEqual(store.health(), {"services": {}})
            for item in shipped["links"]:
                with self.subTest(resource=item["id"]):
                    parsed = server.urlsplit(item["url"])
                    self.assertEqual(item["kind"], "website")
                    self.assertFalse(item["monitorEnabled"])
                    self.assertEqual(parsed.scheme, "https")
                    self.assertFalse(server.local_hostname(parsed.hostname or ""))
                    self.assertIsNone(parsed.username)
                    self.assertIsNone(parsed.password)
                    self.assertIn(parsed.path, ("", "/"))
                    self.assertEqual(parsed.query, "")
                    self.assertEqual(parsed.fragment, "")
                    for field in ("server", "container", "serviceGroup", "description"):
                        self.assertNotIn(field, item)


class MetadataCase(unittest.TestCase):
    def test_known_site_recognized_without_network(self):
        with patch("server.urlopen") as request:
            result = server.metadata("github.com", sample()["categories"])
        request.assert_not_called()
        self.assertEqual(result["name"], "GitHub")
        self.assertEqual(result["categoryId"], "dev")
        self.assertEqual(result["url"], "https://github.com")

    def test_known_sites_use_personal_categories_and_legacy_aliases(self):
        categories = [{"id": name, "name": name} for name in ("AI", "邮箱", "购物", "科技社区", "漫画", "效率办公", "生活工具")]
        expectations = (
            ("chatgpt.com", "ChatGPT", "chatgpt", "AI"),
            ("mail.google.com", "Gmail", "gmail", "邮箱"),
            ("mail.163.com", "163邮箱", "mdi-email", "邮箱"),
            ("mail.10086.cn", "139邮箱", "mdi-email", "效率办公"),
            ("linux.do", "Linux.do", "linux-do", "科技社区"),
            ("ithome.com", "IT之家", "mdi-newspaper", "科技社区"),
            ("v2ex.com", "V2EX", "mdi-forum", "科技社区"),
            ("jd.com", "京东", "mdi-shopping", "购物"),
            ("taobao.com", "淘宝", "taobao", "购物"),
            ("www.komiic.cc", "Komiic", "mdi-book-open-page-variant", "漫画"),
            ("www.mangacopy.com", "拷贝漫画", "mdi-book-open-page-variant", "漫画"),
        )
        with patch("server.urlopen") as request:
            for hostname, name, icon, category in expectations:
                with self.subTest(hostname=hostname):
                    result = server.metadata(hostname, categories)
                    self.assertEqual((result["name"], result["icon"], result["categoryId"]), (name, icon, category))
            legacy = [{"id": name, "name": name} for name in ("AI 工具", "效率办公", "生活工具")]
            for hostname, category in (("chatgpt.com", "AI 工具"), ("mail.google.com", "效率办公"), ("taobao.com", "生活工具")):
                with self.subTest(legacy=hostname):
                    self.assertEqual(server.metadata(hostname, legacy)["categoryId"], category)
            self.assertIsNone(server.metadata("linux.do", legacy)["categoryId"])
        request.assert_not_called()

    def test_office_sites_prefer_office_without_reclassifying_email(self):
        categories = [{"id": name, "name": name} for name in ("邮箱", "效率办公", "办公", "AI")]
        expectations = (
            ("mail.10086.cn", "139邮箱", "mdi-email", "办公"),
            ("mail.google.com", "Gmail", "gmail", "邮箱"),
            ("mail.163.com", "163邮箱", "mdi-email", "邮箱"),
            ("notion.so", "Notion", "notion", "办公"),
            ("www.notion.com", "Notion", "notion", "办公"),
            ("figma.com", "Figma", "figma", "办公"),
            ("feishu.cn", "飞书", "feishu", "办公"),
            ("www.grok.com", "Grok", "grok", "AI"),
            ("www.qianwen.com", "千问（通义）", "tongyi", "AI"),
            ("tongyi.com", "通义", "tongyi", "AI"),
            ("www.copilot.com", "Microsoft Copilot", "copilot", "AI"),
            ("copilot.microsoft.com", "Copilot", "copilot", "AI"),
            ("docs.qq.com", "腾讯文档", "tencent-docs", "办公"),
            ("www.kdocs.cn", "金山文档", "kdocs", "办公"),
            ("www.deepl.com", "DeepL", "deepl", "办公"),
        )
        with patch("server.urlopen") as request:
            for hostname, name, icon, category in expectations:
                with self.subTest(hostname=hostname):
                    result = server.metadata(hostname, categories)
                    self.assertEqual((result["name"], result["icon"], result["categoryId"]), (name, icon, category))
            email_only = [{"id": "email", "name": "邮箱"}]
            self.assertEqual(server.metadata("mail.10086.cn", email_only)["categoryId"], "email")
            legacy = [{"id": "legacy", "name": "效率办公"}]
            for hostname in ("mail.10086.cn", "notion.so", "notion.com", "docs.qq.com", "kdocs.cn", "deepl.com"):
                with self.subTest(legacy=hostname):
                    self.assertEqual(server.metadata(hostname, legacy)["categoryId"], "legacy")
            office_only = [{"id": "office", "name": "办公"}]
            for hostname in ("mail.google.com", "mail.163.com"):
                with self.subTest(office_only=hostname):
                    self.assertIsNone(server.metadata(hostname, office_only)["categoryId"])
        request.assert_not_called()

    def test_entertainment_sites_prefer_new_category_and_keep_legacy_mapping(self):
        categories = [{"id": "legacy", "name": "影音生活"}, {"id": "entertainment", "name": "影音娱乐"}]
        with patch("server.urlopen") as request:
            for hostname in ("bilibili.com", "youtube.com", "spotify.com"):
                with self.subTest(hostname=hostname):
                    self.assertEqual(server.metadata(hostname, categories)["categoryId"], "entertainment")
                    self.assertEqual(server.metadata(hostname, categories[:1])["categoryId"], "legacy")
        request.assert_not_called()

    def test_failed_metadata_still_returns_saveable_service(self):
        with patch("server.urlopen", side_effect=TimeoutError):
            result = server.metadata("nas.home:5000", sample()["categories"])
        self.assertEqual(result["kind"], "service")
        self.assertEqual(result["name"], "nas.home")
        self.assertEqual(result["url"], "http://nas.home:5000")

    def test_unknown_unreachable_site_is_not_assigned_first_category(self):
        with patch("server.urlopen", side_effect=TimeoutError):
            result = server.metadata("https://unrecognized.example", sample()["categories"])
        self.assertEqual(result["kind"], "website")
        self.assertEqual(result["name"], "unrecognized.example")
        self.assertIsNone(result["categoryId"])

    def test_known_site_with_missing_category_remains_uncategorized(self):
        only_ai = sample()["categories"][:1]
        with patch("server.urlopen") as request:
            result = server.metadata("https://github.com", only_ai)
        request.assert_not_called()
        self.assertEqual(result["name"], "GitHub")
        self.assertIsNone(result["categoryId"])

    def test_html_title_and_relative_icon(self):
        headers = Message()
        headers["Content-Type"] = "text/html; charset=utf-8"
        class Response:
            url = "https://example.org/folder"
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, limit):
                return b'<title>Example &amp; Tools</title><link rel="icon" href="/icon.svg">'
        response = Response()
        response.headers = headers
        with patch("server.urlopen", return_value=response):
            result = server.metadata("https://example.org/folder", sample()["categories"])
        self.assertEqual(result["name"], "Example & Tools")
        self.assertEqual(result["icon"], "https://example.org/icon.svg")
        self.assertIsNone(result["categoryId"])

    def test_login_required_response_is_reachable(self):
        error = HTTPError("http://nas.home", 401, "Unauthorized", {}, None)
        with patch("server.urlopen", side_effect=error):
            result = server.probe("http://nas.home")
        self.assertTrue(result["ok"])
        self.assertEqual(result["httpStatus"], 401)

    def test_only_http_urls_accepted(self):
        for value in ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.org", "https://a:b@example.org"]:
            with self.subTest(value=value), self.assertRaises(server.APIError):
                server.normalize_url(value)


class HTTPCase(DataFixture):
    def setUp(self):
        super().setUp()
        self.public = self.directory / "public"
        self.public.mkdir()
        (self.public / "index.html").write_text("<p>轻航</p>", "utf-8")
        self.app = server.AppServer(("127.0.0.1", 0), self.store, self.public)
        self.worker = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.worker.start()
        self.base = "http://127.0.0.1:" + str(self.app.server_port)

    def tearDown(self):
        self.app.shutdown()
        self.app.server_close()
        self.app.monitor.close()
        self.app.link_checker.close()
        self.worker.join(timeout=2)
        super().tearDown()

    def request(self, path, value=None, method="GET", headers=None):
        data = json.dumps(value).encode() if value is not None else None
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        try:
            with urlopen(Request(self.base + path, data=data, method=method, headers=request_headers), timeout=2) as response:
                return response.status, response.read()
        except HTTPError as error:
            try:
                return error.code, error.read()
            finally:
                error.close()

    def test_state_roundtrip_and_conflict_status(self):
        status, body = self.request("/api/state")
        self.assertEqual(status, 200)
        value = json.loads(body)
        self.assertEqual(self.request("/api/state", value, "PUT")[0], 200)
        self.assertEqual(self.request("/api/state", value, "PUT")[0], 409)

    def test_metadata_and_disabled_manual_check(self):
        status, body = self.request("/api/metadata", {"url": "github.com"}, "POST")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["categoryId"], "dev")
        self.assertEqual(self.request("/api/check", {}, "POST")[0], 202)

    def test_link_check_endpoints(self):
        result = {"status": "redirected", "httpStatus": 200, "finalUrl": "https://example.org/", "message": "已跳转到 example.org"}
        with patch("server.check_link", return_value=result):
            status, body = self.request("/api/link-check", {}, "POST")
            self.assertEqual(status, 202)
            self.assertEqual(json.loads(body)["job"]["total"], 1)
            for _ in range(100):
                payload = json.loads(self.request("/api/link-check")[1])
                if not payload["job"]["running"]:
                    break
                time.sleep(0.02)
        self.assertEqual(payload["job"]["done"], 1)
        self.assertEqual(payload["results"]["github"]["finalUrl"], "https://example.org/")
        self.assertEqual(self.request("/api/link-check", {"ids": "github"}, "POST")[0], 400)

    def test_batch_metadata_uses_known_sites_only(self):
        with patch("server.urlopen") as request:
            status, body = self.request("/api/metadata", {"urls": ["github.com", "https://example.org/a", "javascript:alert(1)"]}, "POST")
        request.assert_not_called()
        self.assertEqual(status, 200)
        github, unknown, invalid = json.loads(body)["items"]
        self.assertEqual((github["name"], github["categoryId"]), ("GitHub", "dev"))
        self.assertEqual((unknown["name"], unknown["icon"]), ("example.org", ""))
        self.assertIsNone(invalid)
        self.assertEqual(self.request("/api/metadata", {"urls": "github.com"}, "POST")[0], 400)

    def test_static_cannot_escape_public_directory(self):
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/%2e%2e/seed.json")[0], 404)
        self.assertEqual(self.request("/api/missing")[0], 404)

    def test_cross_site_write_rejected(self):
        status, body = self.request("/api/state", self.store.state(), "PUT", {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertIn("不允许跨站", json.loads(body)["error"])



class FakeSite(BaseHTTPRequestHandler):
    """Local stand-in for websites in various states of health."""

    def log_message(self, *args):
        pass

    def answer(self, body=True):
        port = self.server.server_port
        routes = {
            "/ok": (200, {}),
            "/gone": (404, {}),
            "/removed": (410, {}),
            "/moved": (301, {"Location": "http://localhost:%d/ok" % port}),
            "/same-site": (302, {"Location": "/ok"}),
            "/login": (302, {"Location": "http://localhost:%d/accounts/login" % port}),
            "/accounts/login": (200, {}),
            "/forbidden": (403, {}),
            "/challenge": (503, {"cf-mitigated": "challenge"}),
            "/error": (500, {}),
        }
        if self.path == "/no-head" and self.command == "HEAD":
            status, headers = 405, {}
        elif self.path == "/no-head":
            status, headers = 200, {}
        else:
            status, headers = routes.get(self.path, (404, {}))
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.answer()

    def do_GET(self):
        self.answer()


class LinkStatusCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = ThreadingHTTPServer(("127.0.0.1", 0), FakeSite)
        cls.thread = threading.Thread(target=cls.site.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.site.server_port

    @classmethod
    def tearDownClass(cls):
        cls.site.shutdown()
        cls.site.server_close()

    def status(self, path):
        return server.link_status(self.base + path, timeout=2)

    def test_classifies_responses(self):
        expectations = {
            "/ok": "ok", "/same-site": "ok", "/no-head": "ok",
            "/gone": "broken", "/removed": "broken",
            "/moved": "redirected", "/login": "ok",
            "/forbidden": "restricted", "/challenge": "restricted",
            "/error": "unreachable",
        }
        for path, expected in expectations.items():
            with self.subTest(path=path):
                self.assertEqual(self.status(path)["status"], expected)
        moved = self.status("/moved")
        self.assertEqual(moved["finalUrl"], "http://localhost:%d/ok" % self.site.server_port)
        self.assertEqual(self.status("/gone")["httpStatus"], 404)

    def test_network_failures(self):
        cases = (
            (URLError(socket.gaierror(8, "nodename nor servname provided")), "broken", "域名无法解析"),
            (URLError(TimeoutError("timed out")), "unreachable", "请求超时"),
            (URLError(ConnectionRefusedError(61, "refused")), "unreachable", "连接被拒绝"),
            (URLError(ssl.SSLError("bad cert")), "unreachable", "证书无效或加密连接失败"),
            (TimeoutError("timed out"), "unreachable", "请求超时"),
        )
        for error, status, message in cases:
            with self.subTest(message=message), patch("server.urlopen", side_effect=error):
                result = server.link_status("https://example.invalid")
            self.assertEqual((result["status"], result["message"]), (status, message))

    def test_failures_are_retried_once(self):
        answers = iter([{"status": "unreachable"}, {"status": "ok"}])
        with patch("server.link_status", side_effect=lambda *args: next(answers)) as status, patch("server.time.sleep"):
            self.assertEqual(server.check_link("https://example.org")["status"], "ok")
        self.assertEqual(status.call_count, 2)
        with patch("server.link_status", return_value={"status": "restricted"}) as status:
            server.check_link("https://example.org")
        self.assertEqual(status.call_count, 1)

    def test_redirect_rules(self):
        self.assertFalse(server.moved_elsewhere("https://mail.google.com/", "https://accounts.google.com/ServiceLogin"))
        self.assertFalse(server.moved_elsewhere("https://www.bbc.co.uk/", "https://news.bbc.co.uk/"))
        self.assertFalse(server.moved_elsewhere("https://a.com/", "https://sso.b.com/"))
        self.assertTrue(server.moved_elsewhere("https://old.com/", "https://new.com/home"))


class LinkCheckCase(DataFixture):
    def wait(self, checker):
        for _ in range(100):
            if not checker.status()["running"]:
                return
            time.sleep(0.02)
        self.fail("link check did not finish")

    def test_job_records_results_and_rejects_overlap(self):
        checker = server.LinkChecker(self.store)
        release = threading.Event()

        def slow(url, timeout):
            release.wait(2)
            return {"status": "broken", "httpStatus": 404, "finalUrl": None, "message": "页面不存在（HTTP 404）"}

        with patch("server.check_link", side_effect=slow):
            job = checker.start()
            self.assertEqual((job["running"], job["total"]), (True, 1))
            with self.assertRaises(server.APIError) as raised:
                checker.start()
            self.assertEqual(raised.exception.status, 409)
            release.set()
            self.wait(checker)
        self.assertEqual(checker.status()["done"], 1)
        result = self.store.link_checks()["github"]
        self.assertEqual((result["status"], result["url"]), ("broken", "https://github.com"))
        self.assertIsNotNone(result["checkedAt"])
        self.assertNotIn("nas", self.store.link_checks())

    def test_results_follow_link_edits(self):
        self.store.record_link_check(self.store.state()["links"][0], {"status": "broken"})
        value = self.store.state()
        value["links"][0]["name"] = "GitHub 主页"
        value = self.store.save(value)
        self.assertIn("github", self.store.link_checks())
        value["links"][0]["url"] = "https://github.com/explore"
        value = self.store.save(value)
        self.assertEqual(self.store.link_checks(), {})
        self.store.record_link_check({"id": "github", "url": "https://github.com"}, {"status": "broken"})
        self.assertEqual(self.store.link_checks(), {})

    def test_deleted_link_result_returns_with_undo_until_next_check(self):
        original = self.store.state()
        self.store.record_link_check(original["links"][0], {"status": "broken"})
        removed = copy.deepcopy(original)
        removed["links"] = removed["links"][1:]
        removed = self.store.save(removed)
        self.assertEqual(self.store.link_checks(), {})
        restored = copy.deepcopy(original)
        restored["revision"] = removed["revision"]
        restored = self.store.save(restored)
        self.assertEqual(self.store.link_checks()["github"]["status"], "broken")
        removed["revision"] = restored["revision"]
        self.store.save(removed)
        self.store.prune_link_checks()
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM link_check").fetchone()[0], 0)

    def test_rejects_bad_selection(self):
        checker = server.LinkChecker(self.store)
        for ids in ("github", [1], ["missing"]):
            with self.subTest(ids=ids), self.assertRaises(server.APIError):
                checker.start(ids)


if __name__ == "__main__":
    unittest.main()
