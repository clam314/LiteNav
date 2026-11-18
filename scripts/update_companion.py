#!/usr/bin/env python3
"""Refresh the companion character catalogs from their upstream sources.

Brown Dust 2: the roster that clam314/bd2web keeps in sync with
myssal/Brown-Dust-2-Asset is used as is.

NIKKE: Nikke-db/Nikke-db.github.io is read at its latest commit. The l2d file
tree decides which outfits exist (its l2d.json index misses some), each
skeleton header gives the Spine runtime version, and scripts/nikke-names.json
supplies Chinese names, falling back to the index's English names.

Both catalogs pin an upstream commit, so the browser never loads moving
assets. Standard library only; set GITHUB_TOKEN to raise the API rate limit.

    python3 scripts/update_companion.py            # update both catalogs
    python3 scripts/update_companion.py --game nikke
    python3 scripts/update_companion.py --check    # exit 1 if anything would change
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BD2_CATALOG = ROOT / "public/companion/catalog.json"
NIKKE_CATALOG = ROOT / "public/companion/nikke/catalog.json"
NIKKE_NAMES = ROOT / "scripts/nikke-names.json"

BD2_ROSTER = "https://raw.githubusercontent.com/clam314/bd2web/main/data/roster.json"
NIKKE_REPO = "Nikke-db/Nikke-db.github.io"
NIKKE_RAW = "https://raw.githubusercontent.com/" + NIKKE_REPO + "/{commit}/"

PLAYABLE_ID = re.compile(r"c(\d{3})(?:_(\d{2}))?")
# NPCs (c9xx), mass-produced enemies (c25x) and male characters are not shown.
NIKKE_EXCLUDED = {
    "c803", "c803_01",  # Denji
    "c804",  # Aki Hayakawa
    "c813",  # 9S
}
# Outfits that need a specific skin, following clam314/Nikkiweb.
NIKKE_STAND_SKINS = {
    **dict.fromkeys(["c220", "c102", "c940", "c101_01", "c350", "c810", "c810_01", "c321"], "acc"),
    **dict.fromkeys(["c351", "c070_02", "c810_02"], "bg"),
}


def request(url: str, headers: dict | None = None, attempts: int = 3) -> bytes:
    headers = {"User-Agent": "LiteNav-catalog-update", **(headers or {})}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = "Bearer " + token
    # Hundreds of small requests run per update; ride out transient network errors.
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == attempts - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def get_json(url: str):
    return json.loads(request(url))


def dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=1)


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --- Brown Dust 2 -----------------------------------------------------------

def validate_bd2(roster) -> dict:
    if not isinstance(roster, dict) or not re.fullmatch(r"[0-9a-f]{12,40}", str(roster.get("commit", ""))):
        raise ValueError("bd2 roster has no pinned commit")
    characters = roster.get("characters")
    if not isinstance(characters, list) or not characters:
        raise ValueError("bd2 roster has no characters")
    for character in characters:
        if not character.get("id") or not character.get("costumes"):
            raise ValueError(f"bd2 character without id or costumes: {character!r:.80}")
    return roster


def update_bd2() -> tuple[Path, str]:
    return BD2_CATALOG, dump(validate_bd2(get_json(BD2_ROSTER)))


# --- NIKKE ------------------------------------------------------------------

def read_spine_version(header: bytes) -> str:
    """Return the version string after the hash in a Spine 4.x binary header."""
    position = 0

    def varint() -> int:
        nonlocal position
        value = shift = 0
        while True:
            byte = header[position]
            position += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value
            shift += 7

    def string() -> str:
        nonlocal position
        length = varint()
        if length == 0:
            return ""
        text = header[position:position + length - 1].decode("utf-8")
        position += length - 1
        return text

    position += 8  # 64-bit skeleton hash
    version = string()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError(f"unexpected Spine header version {version!r}")
    return version


def runtime_for(version: str) -> str:
    return "4.1" if version.startswith("4.1") else "4.0"


def parse_id(value: str):
    match = PLAYABLE_ID.fullmatch(value)
    return (match.group(1), match.group(2)) if match else None


def is_shown(outfit_id: str, english: str) -> bool:
    parsed = parse_id(outfit_id)
    if not parsed or outfit_id in NIKKE_EXCLUDED:
        return False
    number = int(parsed[0])
    if number >= 900 or 250 <= number <= 259:
        return False
    return not english.lower().endswith("_old")


def outfit_files(paths: set[str], outfit_id: str) -> dict:
    """Stand and aim files present in the l2d tree for one outfit."""
    files = {}
    for mode, stem in (("stand", f"{outfit_id}/{outfit_id}_00"), ("aim", f"{outfit_id}/aim/{outfit_id}_aim_00")):
        if f"{stem}.skel" in paths and f"{stem}.atlas" in paths:
            files[mode] = {"skeleton": f"l2d/{stem}.skel", "atlas": f"l2d/{stem}.atlas"}
    return files


def build_nikke(tree_paths: set[str], index: list, names: dict, versions: dict, skipped: list | None = None) -> list:
    """Group outfits into people. versions maps skeleton path -> runtime.

    Outfits of a known person may lack a name of their own; a new person
    without any name is left out (and reported) until it is named, since it
    could be an NPC or a male character.
    """
    english = {entry["id"]: str(entry.get("name") or "") for entry in index if isinstance(entry, dict) and entry.get("id")}
    outfits = sorted({path.split("/")[0] for path in tree_paths if parse_id(path.split("/")[0])})
    people: dict[str, dict] = {}
    person_of: dict[str, str] = {}
    for outfit_id in outfits:
        files = outfit_files(tree_paths, outfit_id)
        if "stand" not in files or not is_shown(outfit_id, english.get(outfit_id, "")):
            continue
        number, suffix = parse_id(outfit_id)
        zh = names.get(outfit_id, "")
        if zh:
            # Names separate person and outfit with a full- or half-width colon.
            parts = [part.strip() for part in re.split(r"[：:]", zh, maxsplit=1)]
            person, label = parts[0], parts[1] if len(parts) > 1 else ""
        elif suffix and f"c{number}" in person_of:
            person, label = person_of[f"c{number}"], english.get(outfit_id) or f"未命名时装 {outfit_id}"
        elif english.get(outfit_id):
            person, label = english[outfit_id].replace("_", " "), ""
        else:
            if skipped is not None:
                skipped.append(outfit_id)
            continue
        person_of[outfit_id] = person
        entry = people.setdefault(person, {"id": f"nikke:{outfit_id}", "name": person,
                                           "aka": english.get(outfit_id, "").replace("_", " "), "costumes": []})
        costume = {"label": label or "默认", "outfit": outfit_id}
        for mode, part in (("idle", files["stand"]), ("cutscene", files.get("aim"))):
            if not part:
                costume[mode] = None
                continue
            costume[mode] = {**part, "runtime": versions[part["skeleton"]]}
            if mode == "idle" and outfit_id in NIKKE_STAND_SKINS:
                costume[mode]["skin"] = NIKKE_STAND_SKINS[outfit_id]
        entry["costumes"].append(costume)
    characters = sorted(people.values(), key=lambda person: person["id"])
    for person in characters:
        person["costumes"].sort(key=lambda costume: (costume["label"] != "默认", costume["outfit"]))
    return characters


def update_nikke() -> tuple[Path, str]:
    api = "https://api.github.com/repos/" + NIKKE_REPO
    commit = get_json(api + "/commits/main")["sha"]
    root = get_json(f"{api}/git/trees/{commit}")
    l2d = next(item["sha"] for item in root["tree"] if item["path"] == "l2d")
    tree = get_json(f"{api}/git/trees/{l2d}?recursive=1")
    if tree.get("truncated"):
        raise ValueError("Nikke-db l2d tree was truncated")
    paths = {item["path"] for item in tree["tree"]}
    raw = NIKKE_RAW.format(commit=commit)
    index = get_json(raw + "js/json/l2d.json")
    names = json.loads(NIKKE_NAMES.read_text(encoding="utf-8"))

    # Read only the header of each skeleton that the catalog will reference.
    english = {entry.get("id"): str(entry.get("name") or "") for entry in index if isinstance(entry, dict)}
    wanted = [part["skeleton"] for outfit in {p.split("/")[0] for p in paths}
              if parse_id(outfit) and is_shown(outfit, english.get(outfit, ""))
              for part in outfit_files(paths, outfit).values()]
    with ThreadPoolExecutor(max_workers=8) as pool:
        headers = pool.map(lambda path: request(raw + path, {"Range": "bytes=0-63"}), wanted)
        versions = {path: runtime_for(read_spine_version(header)) for path, header in zip(wanted, headers)}

    skipped: list[str] = []
    characters = build_nikke(paths, index, names, versions, skipped)
    if skipped:
        print(f"nikke: {len(skipped)} unnamed outfits left out; name them in {NIKKE_NAMES.relative_to(ROOT)}: "
              + ", ".join(skipped))
    previous = json.loads(NIKKE_CATALOG.read_text(encoding="utf-8")) if NIKKE_CATALOG.exists() else {}
    if previous.get("characters") == characters:
        # Unrelated upstream commits (story art, galleries) keep the pinned commit.
        return NIKKE_CATALOG, dump(previous)
    return NIKKE_CATALOG, dump({"generatedAt": now(), "source": f"{NIKKE_REPO}@{commit[:12]}",
                                "commit": commit, "characters": characters})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", choices=["bd2", "nikke", "all"], default="all")
    parser.add_argument("--check", action="store_true", help="report changes without writing")
    args = parser.parse_args()
    updates = [update for game, update in (("bd2", update_bd2), ("nikke", update_nikke)) if args.game in (game, "all")]
    changed = []
    for update in updates:
        path, content = update()
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            changed.append(path.relative_to(ROOT))
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
    for path in changed:
        print(("would update " if args.check else "updated ") + str(path))
    if not changed:
        print("catalogs are up to date")
    return 1 if args.check and changed else 0


if __name__ == "__main__":
    sys.exit(main())
