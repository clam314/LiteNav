"""Browser regressions for the real companion controls, without remote assets.

Run separately from the dependency-free unit suite:
  python -m pip install -r tests/requirements-browser.txt
  python -m playwright install chromium
  python tests/companion_ui_browser.py

The fixture imports the production JS and CSS. Only the network and Spine's
renderer are replaced; clicks, focus, keyboard events and hit testing are real.
"""

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

from playwright.sync_api import expect, sync_playwright


PUBLIC = Path(__file__).resolve().parents[1] / "public"
PREFERENCE_KEY = "guihang.companion.preferences"
FIXTURE = """<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/companion.css">
</head><body><main class="workspace"><div class="page-content"><a href="#target">导航链接</a></div></main>
<div id="companion-root"></div><script type="module">
import { initCompanion } from '/companion.js';
try { window.companion = initCompanion(); }
catch (error) { window.initializationError = error.message; }
</script></body></html>"""

CATALOG = {
    "commit": "424622b8c4fd",
    "characters": [{"id": "0002", "name": "悠丝缇亚", "costumes": [{
        "label": "血骑士",
        "idle": {"skeleton": "spine/char/char000201/char000201.skel", "atlas": "spine/char/char000201/char000201.atlas"},
        "cutscene": {"skeleton": "spine/cutscenes/test.skel", "atlas": "spine/cutscenes/test.atlas"},
    }]}],
}

CATALOG["characters"].append({"id": "0001", "name": "拉德尔", "costumes": [{
    "label": "草药猎人",
    "idle": {"skeleton": "spine/char/char000101/char000101.skel", "atlas": "spine/char/char000101/char000101.atlas"},
    "cutscene": {"skeleton": "spine/cutscenes/male-test.skel", "atlas": "spine/cutscenes/male-test.atlas"},
}]})

# A renderer double lets the production component reach its loaded state while
# keeping this test independent of GPU availability and external model servers.
RENDERER = """(() => {
  HTMLCanvasElement.prototype.getContext = () => ({ getExtension: () => ({ loseContext() {} }) });
  const idle = { name: 'idle', duration: 4, apply() {} };
  window.spine = { SpinePlayer: class {
    constructor(parent, config) {
      this.config = config;
      (window.testPlayers ||= []).push(this);
      this.dom = document.createElement('div'); this.dom.className = 'spine-player';
      this.dom.append(document.createElement('canvas')); parent.append(this.dom);
      this.context = { gl: { getExtension: () => ({ loseContext() {} }) } };
      this.canvas = this.dom.firstChild;
      this.skeleton = { data: { animations: [idle], findAnimation: () => null }, drawOrder: [], color: { a: 1 },
        setToSetupPose() {}, updateWorldTransform() {} };
      this.animationState = { data: { skeletonData: { findAnimation: () => null } },
        clearTracks() {}, apply() {}, update() {}, getCurrent: () => ({ animation: idle }) };
      requestAnimationFrame(() => {
        if (this.disposed) return;
        config.success(this);
        if (!this.disposed) config.draw(this);
      });
    }
    calculateAnimationViewport(animation, box) { Object.assign(box, { x: 0, y: 0, width: 400, height: 800 }); }
    setAnimation() { this.currentViewport = { ...this.config.viewport, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 }; }
    play() { this.paused = false; }
    pause() { this.paused = true; }
    stopRendering() {}
    dispose() { this.disposed = true; this.dom.remove(); }
  } };
})();"""


# Browsers report a background tab as hidden; this stands in for switching away and back.
VISIBILITY = """(hidden) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def preferences(**changes):
    return {"random": False, "portraits": True, "skills": False,
            "characterId": "0002", "costumeKey": "spine/char/char000201/char000201.skel", "skillAction": "", **changes}


def run_cases(browser, origin, case_filter=None):
    results = []

    def case(name, run, *, offline=False, media_failure=False, blocked_storage=False, prefs=None):
        if case_filter and case_filter not in name:
            return
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        context.add_init_script(RENDERER)
        if blocked_storage:
            context.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });")
        else:
            value = json.dumps(preferences() if prefs is None else prefs, ensure_ascii=False)
            context.add_init_script(f"if (localStorage.getItem({json.dumps(PREFERENCE_KEY)}) === null) localStorage.setItem({json.dumps(PREFERENCE_KEY)}, {json.dumps(value)});")
        if media_failure:
            context.add_init_script("window.matchMedia = () => { throw new Error('media query unavailable'); };")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/companion-ui-fixture", lambda route: route.fulfill(content_type="text/html", body=FIXTURE))
        page.route("**/companion/catalog.json", lambda route: route.abort() if offline else route.fulfill(json=CATALOG))
        page.route("**/companion/gamekee-presets.json", lambda route: route.fulfill(json={}))
        # Keep cases hermetic: only the fixture catalog provides people.
        page.route("**/companion/nikke/catalog.json", lambda route: route.abort())
        page.route("**/companion/azurlane/catalog.json", lambda route: route.abort())
        page.route("**/companion/destinychild/catalog.json", lambda route: route.abort())

        def asset(route):
            if route.request.url.endswith(".atlas"):
                route.fulfill(content_type="text/plain", body="test.png\nsize: 1,1\n")
            else:
                route.fulfill(content_type="application/octet-stream", body=b"test asset")

        page.route("**/companion/assets/**", asset)
        page.route("https://raw.githubusercontent.com/**", asset)
        try:
            page.goto(origin + "/companion-ui-fixture")
            # The first check also waits for the module graph to load, which can
            # take longer than the 5 s default on a busy machine.
            expect(page.get_by_role("button", name="角色设置", exact=True)).to_be_visible(timeout=15000)
            run(page)
            assert errors == [], f"uncaught page errors: {errors}"
            assert page.evaluate("window.initializationError || null") is None
            print("PASS", name, flush=True)
            results.append(name)
        except Exception:
            print(f"FAIL {name}; initialization={page.evaluate('window.initializationError || null')!r}; errors={errors!r}", flush=True)
            raise
        finally:
            context.close()

    def open_menu(page):
        toggle = page.get_by_role("button", name="角色设置", exact=True)
        toggle.click()
        expect(toggle).to_have_attribute("aria-expanded", "true")
        expect(page.get_by_role("region", name="角色设置", exact=True)).to_be_visible()

    def normal_menu(page):
        open_menu(page)
        expect(page.get_by_role("button", name="关闭角色设置", exact=True)).to_be_focused()
        page.keyboard.press("Escape")
        expect(page.get_by_role("button", name="角色设置", exact=True)).to_be_focused()
        page.keyboard.press("Enter")
        expect(page.get_by_role("region", name="角色设置", exact=True)).to_be_visible()
        page.get_by_role("button", name="角色设置", exact=True).click()
        expect(page.get_by_role("region", name="角色设置", exact=True)).to_be_hidden()
        open_menu(page)
        page.get_by_role("link", name="导航链接").click()
        expect(page.get_by_role("region", name="角色设置", exact=True)).to_be_hidden()

    case("mouse, keyboard, Escape and outside click operate the actual menu", normal_menu)
    case("menu remains usable when media-query initialization is unavailable", normal_menu, media_failure=True)

    def unavailable_skill(page):
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        open_menu(page)
        page.get_by_role("radio", name="动作", exact=True).click()
        expect(page.get_by_role("radio", name="动作", exact=True)).not_to_be_checked()
        expect(page.get_by_role("radio", name="立绘", exact=True)).to_be_checked()
        expect(page.locator(".companion-menu-note")).to_contain_text("没有符合展示选项的角色")
        page.get_by_role("switch", name="角色陪伴", exact=True).click()
        expect(page.locator("body")).to_have_attribute("data-companion", "off")
        expect(page.locator("#companion-root canvas")).to_have_count(0)

    case("unavailable offline skill cannot trap the active portrait or throw a UI error", unavailable_skill, offline=True)

    def close_all(page):
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        before = page.evaluate(f"JSON.parse(localStorage.getItem({json.dumps(PREFERENCE_KEY)}))")
        open_menu(page)
        page.get_by_role("switch", name="角色陪伴", exact=True).click()
        expect(page.locator("body")).to_have_attribute("data-companion", "off")
        expect(page.locator("#companion-root canvas")).to_have_count(0)
        expect(page.get_by_role("switch", name="角色陪伴", exact=True)).not_to_be_checked()
        expect(page.get_by_role("radio", name="轮流", exact=True)).to_be_checked()
        after = page.evaluate(f"JSON.parse(localStorage.getItem({json.dumps(PREFERENCE_KEY)}))")
        for key in ["random", "characterId", "costumeKey", "skillAction"]:
            assert after[key] == before[key], f"closing must preserve {key}"
        assert after["resume"] == "both" and not after["portraits"] and not after["skills"]
        page.reload()
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'off'")
        expect(page.locator("#companion-root canvas")).to_have_count(0)
        open_menu(page)
        expect(page.get_by_role("switch", name="角色陪伴", exact=True)).not_to_be_checked()
        expect(page.get_by_role("button", name="换一位", exact=True)).to_be_disabled()

    case("one switch closes both modes and retains the chosen person after reload", close_all, prefs=preferences(skills=True))

    def no_storage(page):
        open_menu(page)
        page.get_by_role("switch", name="角色陪伴", exact=True).click()
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        page.get_by_role("switch", name="角色陪伴", exact=True).click()
        expect(page.locator("body")).to_have_attribute("data-companion", "off")
        expect(page.locator("#companion-root canvas")).to_have_count(0)

    case("the controls work with browser storage blocked", no_storage, blocked_storage=True)

    def hidden_release(page):
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        expect(page.locator("#companion-root canvas")).to_have_count(1)
        page.clock.install()
        page.evaluate(VISIBILITY, True)
        page.clock.fast_forward("02:50")
        expect(page.locator("#companion-root canvas")).to_have_count(1)
        page.clock.fast_forward("00:20")
        expect(page.locator("#companion-root canvas")).to_have_count(0)
        page.clock.resume()
        page.evaluate(VISIBILITY, False)
        expect(page.locator("#companion-root canvas")).to_have_count(1)
        expect(page.locator("#companion-root")).to_have_attribute("data-mode", "portrait")

    case("a page hidden for three minutes lets its player go and loads it again when shown", hidden_release)

    def scroll_rest(page):
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        live = "window.testPlayers.filter((player) => !player.disposed)"
        page.wait_for_function(f"{live}.length && {live}.every((player) => player.paused === false)")
        page.mouse.move(400, 400)
        page.mouse.wheel(0, 300)
        page.wait_for_function(f"{live}.every((player) => player.paused === true)", timeout=2000)
        assert page.evaluate("document.querySelector('#companion-root').dataset.paused") == "false", \
            "resting while scrolling is not the paused state"
        page.wait_for_function(f"{live}.every((player) => player.paused === false)", timeout=3000)

    case("the character rests while the page scrolls and moves on after", scroll_rest)

    def live2d_fps(page):
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        open_menu(page)
        switch = page.get_by_role("switch", name="Live2D 每秒 30 帧")
        expect(switch).not_to_be_checked()
        switch.check()
        assert page.evaluate("localStorage.getItem('litenav.companion.live2dFps')") == "30"
        saved = page.evaluate(f"localStorage.getItem({json.dumps(PREFERENCE_KEY)})")
        assert "live2d" not in saved.lower() and "fps" not in saved.lower(), "a setting of this computer, outside the synced preferences"
        page.reload()
        open_menu(page)
        expect(page.get_by_role("switch", name="Live2D 每秒 30 帧")).to_be_checked()
        # Without a game that shows Live2D models it is not offered.
        page.evaluate(f"""localStorage.setItem({json.dumps(PREFERENCE_KEY)}, JSON.stringify({{ ...JSON.parse(localStorage.getItem({json.dumps(PREFERENCE_KEY)})), games: ['bd2', 'nikke'], knownGames: ['bd2', 'nikke', 'azurlane', 'destinychild'] }}))""")
        page.reload()
        open_menu(page)
        expect(page.get_by_role("switch", name="Live2D 每秒 30 帧")).to_have_count(0)

    case("the Live2D frame cap is a switch of this computer", live2d_fps)

    def saved_male(page):
        page.wait_for_function("document.querySelector('#companion-root').dataset.state === 'ready'")
        open_menu(page)
        values = page.get_by_label("指定人物与服装", exact=True).locator("option").evaluate_all("items => items.map(item => item.value)")
        assert values and all("char000101" not in value for value in values)
        saved = page.evaluate(f"JSON.parse(localStorage.getItem({json.dumps(PREFERENCE_KEY)}))")
        assert saved["characterId"] == "0002"
        assert saved["costumeKey"] == "spine/char/char000201/char000201.skel"
        names = [switch.get_attribute("aria-label") for switch in page.get_by_role("switch").all()]
        assert names.count("角色陪伴") == 1 and set(names) <= {"角色陪伴", "碧蓝航线语音", "Live2D 每秒 30 帧"}, \
            f"one master switch, and per-display switches stay gone: {names}"

    case("a saved male is removed from selection and replaced before rendering", saved_male,
         prefs=preferences(characterId="0001", costumeKey="spine/char/char000101/char000101.skel"))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser-executable", help="Optional installed Chromium/headless-shell path")
    parser.add_argument("--case", help="Run only cases whose name contains this text")
    args = parser.parse_args()
    handler = functools.partial(QuietHandler, directory=str(PUBLIC))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            options = {"headless": True}
            if args.browser_executable:
                options["executable_path"] = args.browser_executable
            browser = playwright.chromium.launch(**options)
            try:
                passed = run_cases(browser, f"http://127.0.0.1:{server.server_port}", args.case)
                if not passed:
                    raise SystemExit("No browser regression cases matched the requested filter")
                print(f"{len(passed)} companion browser regressions passed")
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
