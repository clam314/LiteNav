"""Exercise website icon detection and editing with Chromium and a temporary LiteNav database."""
import argparse
from pathlib import Path
import sys
import tempfile
import threading

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import AppServer, Store


def expect_image(image, source):
    expect(image).to_have_attribute("src", source)
    expect(image).not_to_have_js_property("naturalWidth", 0)


def check_icons(page, origin):
    page.goto(origin)
    page.get_by_role("button", name="添加", exact=True).click()
    url = page.locator("#link-url")
    url.fill("outlook.live.com")
    url.press("Enter")
    form = page.locator("#link-form")
    expect(form).to_be_hidden()

    card = page.locator('.site-link[href="https://outlook.live.com/"]')
    expect(card).to_contain_text("Outlook")
    expect_image(card.locator("img"), "/icons/outlook.svg")
    print("PASS immediate submission recognizes Outlook", flush=True)

    def edit(name):
        page.get_by_role("button", name="整理", exact=True).click()
        page.get_by_role("button", name="编辑 " + name, exact=True).click()

    def save():
        form.get_by_role("button", name="保存", exact=True).click()
        expect(form).to_be_hidden()
        page.get_by_role("button", name="完成整理", exact=True).click()

    edit("Outlook")
    custom = origin + "/favicon.svg"
    form.locator("#link-icon").fill(custom)
    form.locator("#link-name").fill("工作邮箱")
    expect_image(form.locator("#link-preview img"), custom)
    save()
    page.reload()
    expect(card).to_contain_text("工作邮箱")
    expect_image(card.locator("img"), custom)
    print("PASS a custom icon survives rename, save and reload", flush=True)

    edit("工作邮箱")
    expect(form.locator("#link-icon")).to_have_value(custom)
    form.locator("#reset-link-icon").click()
    expect_image(form.locator("#link-preview img"), "/icons/outlook.svg")
    save()
    page.reload()
    expect(card).to_contain_text("工作邮箱")
    expect_image(card.locator("img"), "/icons/outlook.svg")
    print("PASS restoring automatic recognition persists after reload", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser-executable", help="Optional installed Chromium/headless-shell path")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory:
        seed = Path(directory) / "seed.json"
        seed.write_text('{"categories": [], "links": []}', encoding="utf-8")
        app = AppServer(("127.0.0.1", 0), Store(directory, seed))
        worker = threading.Thread(target=app.serve_forever, daemon=True)
        worker.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=args.browser_executable)
                try:
                    page = browser.new_page()
                    page.route("https://**", lambda route: route.abort())
                    check_icons(page, f"http://127.0.0.1:{app.server_port}")
                finally:
                    browser.close()
        finally:
            app.shutdown()
            app.server_close()
            app.monitor.close()
            app.link_checker.close()
            worker.join()


if __name__ == "__main__":
    main()
