#!/usr/bin/env python3
"""Build the 轻航 Chrome extension into dist/extension and a zip of it.

The extension is the same front end as the server version (public/), plus
seed.json, LICENSE, and the manifest, background worker and icons from
extension/. Only the Python standard library is needed:

    python3 scripts/build_extension.py

Then load dist/extension in chrome://extensions with 开发者模式 → 加载已解压的扩展程序.
GitHub Actions (.github/workflows/extension.yml) builds the zip after every
change on main, numbered with --build-number.
"""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {".DS_Store", "__pycache__"}


def copy_tree(source: Path, target: Path):
    for path in sorted(source.rglob("*")):
        if any(part in SKIP for part in path.relative_to(source).parts):
            continue
        destination = target / path.relative_to(source)
        if path.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)


def build(out_dir: Path, make_zip: bool = True, grant_optional: bool = False, build_number: int | None = None) -> Path:
    version = json.loads((ROOT / "package.json").read_text("utf-8"))["version"]
    # Chrome versions are up to four numbers, each at most 65535.
    if build_number is not None:
        if not 0 <= build_number <= 65535:
            raise SystemExit("--build-number must be between 0 and 65535")
        version = f"{version}.{build_number}"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    copy_tree(ROOT / "public", out_dir)
    shutil.copy2(ROOT / "seed.json", out_dir / "seed.json")
    # Whoever passes the extension on must pass on its license and notice.
    shutil.copy2(ROOT / "LICENSE", out_dir / "LICENSE")
    copy_tree(ROOT / "extension", out_dir)
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text("utf-8"))
    manifest["version"] = version
    if grant_optional:
        # For automated browser checks only: nobody is there to click Allow.
        manifest["permissions"] += manifest.pop("optional_permissions", [])
        manifest["host_permissions"] = manifest.pop("optional_host_permissions", [])
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    if make_zip:
        archive = out_dir.parent / f"litenav-extension-{version}.zip"
        archive.unlink(missing_ok=True)
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted(out_dir.rglob("*")):
                if path.is_file():
                    bundle.write(path, path.relative_to(out_dir).as_posix())
        return archive
    return out_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "extension", help="output folder (default: dist/extension)")
    parser.add_argument("--no-zip", action="store_true", help="skip the zip archive")
    parser.add_argument("--build-number", type=int, help="append a fourth version number (CI builds)")
    parser.add_argument("--grant-optional", action="store_true",
                        help="grant the optional permissions at install, for automated browser checks (implies --no-zip)")
    args = parser.parse_args()
    if args.grant_optional:
        args.no_zip = True
    result = build(args.out.resolve(), make_zip=not args.no_zip, grant_optional=args.grant_optional, build_number=args.build_number)
    print("Built", args.out.resolve())
    if not args.no_zip:
        print("Packed", result)


if __name__ == "__main__":
    main()
