#!/usr/bin/env python3
"""Refresh the companion character catalogs from their upstream sources.

Brown Dust 2: the roster that clam314/bd2web keeps in sync with
myssal/Brown-Dust-2-Asset is used as is. Jelosus2/BD2-L2D-Viewer (MIT) adds
the full skill performances it choreographs and each costume's 有缘之客
scene; its TypeScript files are parsed as literal data, never run.

NIKKE: Nikke-db/Nikke-db.github.io is read at its latest commit. The l2d file
tree decides which outfits exist, each skeleton header gives the Spine runtime
version, and the l2d index that Nikke-db/nikke-db-vue maintains for its site
supplies Simplified Chinese (cn) and English names. scripts/nikke-names.json
holds manual names that take precedence. A person needs a Chinese name to be
shown; the index leaves male characters and server-only entries without one.

Azur Lane: bungaku-moe/AzurLaneLive2D is read at its latest commit. Each
Live2D/<name>/<name>.model3.json is one skin; censored *_hx copies are left
out when the original exists. Pelom777/AzurLaneData, rebuilt hourly from the
Chinese server, maps each painting name to its ship and Chinese skin name.

Every catalog pins an upstream commit, so the browser never loads moving
assets. Standard library only; set GITHUB_TOKEN to raise the API rate limit.

    python3 scripts/update_companion.py            # update every catalog
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
NIKKE_NAMES_REPO = "Nikke-db/nikke-db-vue"
NIKKE_NAMES_INDEX = "https://raw.githubusercontent.com/" + NIKKE_NAMES_REPO + "/{commit}/src/utils/json/l2d.json"
AZURLANE_CATALOG = ROOT / "public/companion/azurlane/catalog.json"
AZURLANE_REPO = "bungaku-moe/AzurLaneLive2D"
AZURLANE_NAMES_REPO = "Pelom777/AzurLaneData"
AZURLANE_NAMES = "https://raw.githubusercontent.com/" + AZURLANE_NAMES_REPO + "/{commit}/public/data/{table}.json"

PLAYABLE_ID = re.compile(r"c(\d{3})(?:_(\d{2}))?")
# NPCs (c9xx), mass-produced enemies (c25x), soldiers, products and iDolls
# (c300-c308, matched by name too) and male characters are not shown.
NIKKE_EXCLUDED = {
    "c803", "c803_01",  # Denji
    "c804",  # Aki Hayakawa
    "c813",  # 9S
    "c853",  # Adam
}
NIKKE_EXCLUDED_NAMES = re.compile(r"士兵|产品|idoll|soldier|product", re.IGNORECASE)
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


def parse_js_literal(text: str, position: int = 0):
    """Parse one JavaScript object/array literal (as data, never run) -> (value, end).

    Covers what a hand-written mapping file uses: objects with bare or quoted
    keys, arrays, strings, numbers, true/false/null, comments and trailing commas.
    """
    def skip(i: int) -> int:
        while i < len(text):
            if text[i].isspace():
                i += 1
            elif text.startswith("//", i):
                i = text.find("\n", i) if "\n" in text[i:] else len(text)
            elif text.startswith("/*", i):
                end = text.find("*/", i + 2)
                if end < 0:
                    raise ValueError("unterminated comment")
                i = end + 2
            else:
                break
        return i

    def string(i: int) -> tuple[str, int]:
        quote, i, out = text[i], i + 1, []
        escapes = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "0": "\0"}
        while i < len(text) and text[i] != quote:
            if text[i] == "\\":
                char = text[i + 1]
                if char == "u":
                    out.append(chr(int(text[i + 2:i + 6], 16)))
                    i += 6
                    continue
                out.append(escapes.get(char, char))
                i += 2
                continue
            out.append(text[i])
            i += 1
        if i >= len(text):
            raise ValueError("unterminated string")
        return "".join(out), i + 1

    def value(i: int):
        i = skip(i)
        char = text[i]
        if char == "{":
            result, i = {}, skip(i + 1)
            while text[i] != "}":
                if text[i] in "\"'":
                    key, i = string(i)
                else:
                    match = re.compile(r"[A-Za-z_$][\w$]*|\d+").match(text, i)
                    if not match:
                        raise ValueError(f"unexpected key at {i}")
                    key, i = match.group(), match.end()
                i = skip(i)
                if text[i] != ":":
                    raise ValueError(f"expected ':' at {i}")
                result[key], i = value(i + 1)
                i = skip(i)
                if text[i] == ",":
                    i = skip(i + 1)
                elif text[i] != "}":
                    raise ValueError(f"expected ',' or '}}' at {i}")
            return result, i + 1
        if char == "[":
            result, i = [], skip(i + 1)
            while text[i] != "]":
                item, i = value(i)
                result.append(item)
                i = skip(i)
                if text[i] == ",":
                    i = skip(i + 1)
                elif text[i] != "]":
                    raise ValueError(f"expected ',' or ']' at {i}")
            return result, i + 1
        if char in "\"'":
            return string(i)
        match = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|true\b|false\b|null\b").match(text, i)
        if not match:
            raise ValueError(f"unexpected value at {i}")
        word = match.group()
        literal = {"true": True, "false": False, "null": None}
        return (literal[word] if word in literal else float(word) if re.search(r"[.eE]", word) else int(word)), match.end()

    return value(position)


BD2_PERFORMANCES = ROOT / "public/companion/bd2-performances.json"
BD2_VIEWER_REPO = "Jelosus2/BD2-L2D-Viewer"
BD2_VIEWER_MAPPINGS = "https://raw.githubusercontent.com/" + BD2_VIEWER_REPO + "/{commit}/src/utils/cutscene_mappings.ts"
BD2_VIEWER_CHARACTERS = "https://raw.githubusercontent.com/" + BD2_VIEWER_REPO + "/{commit}/src/utils/character_list.ts"
BD2_ASSET_RAW = "https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/{commit}/"
SPEC_KEYS = {"name", "offset", "source", "skin", "hold", "playDuration", "layerOrder", "loop"}


def performance_definitions(entry) -> list[dict]:
    """The viewer's three entry shapes as a list of {"name", "composite"}."""
    def definition(item) -> bool:
        return isinstance(item, dict) and ("composite" in item or "animations" in item)
    if isinstance(entry, list) and entry and all(definition(item) for item in entry):
        items = entry
    elif definition(entry):
        items = [entry]
    else:
        items = [{"composite": entry}]
    return [{"name": item.get("name") or "all", "composite": item.get("composite", item.get("animations"))} for item in items]


def build_bd2_performances(mappings: dict) -> tuple[dict, set[str]]:
    """Normalize BD2-L2D-Viewer's skill compositions -> (costumes, external skeletons).

    Keys become our costume ids (char000101). An external source such as
    "cutscene/glow/cutscene_char067803_1" names a skeleton that the asset
    repository keeps at spine/cutscenes/<name>/<name>.
    """
    costumes, sources = {}, set()

    def spec(item):
        if isinstance(item, str):
            return item
        if isinstance(item, list):
            return [spec(child) for child in item]
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or set(item) - SPEC_KEYS:
            raise ValueError(f"unexpected composite step {item!r:.80}")
        result = dict(item)
        if "source" in item:
            name = re.sub(r"\.(skel|atlas|json)$", "", item["source"].strip().replace("\\", "/")).rsplit("/", 1)[-1]
            if not re.fullmatch(r"cutscene_char\d{6}(?:_\w+)?", name):
                raise ValueError(f"unexpected composite source {item['source']!r}")
            result["source"] = f"spine/cutscenes/{name}/{name}"
            sources.add(result["source"])
        return result

    for key, entry in mappings.items():
        if not re.fullmatch(r"\d{6}", key):
            raise ValueError(f"unexpected costume id {key!r}")
        definitions = performance_definitions(entry)
        for definition in definitions:
            if not isinstance(definition["composite"], list) or not definition["composite"]:
                raise ValueError(f"empty composite for {key}")
            definition["composite"] = [spec(step) for step in definition["composite"]]
        costumes["char" + key] = definitions
    return costumes, sources


def build_bd2_dating(characters: dict) -> dict:
    """Costume id -> its 有缘之客 scene, from BD2-L2D-Viewer's character list.

    The asset repository keeps scene illust_datingN at
    spine/illust/illust_dating/illust_datingN/illust_datingN.
    """
    scenes = {}
    for key, character in characters.items():
        name = character.get("dating") if isinstance(character, dict) else None
        if not name:
            continue
        if not re.fullmatch(r"\d{6}", key) or not re.fullmatch(r"illust_dating\w+", name):
            raise ValueError(f"unexpected dating scene {key!r}: {name!r}")
        scenes["char" + key] = {"skeleton": f"spine/illust/illust_dating/{name}/{name}",
                                "tracks": character.get("datingUsesTracks") is True}
    return scenes


def update_bd2_performances() -> tuple[Path, str]:
    commit = get_json(f"https://api.github.com/repos/{BD2_VIEWER_REPO}/commits/main")["sha"]
    text = request(BD2_VIEWER_MAPPINGS.format(commit=commit)).decode("utf-8")
    start = re.search(r"const\s+cutsceneComposites\b[^=]*=\s*", text)
    if not start:
        raise ValueError("cutscene_mappings.ts has no cutsceneComposites object")
    mappings, _ = parse_js_literal(text, start.end())
    costumes, sources = build_bd2_performances(mappings)
    characters_text = request(BD2_VIEWER_CHARACTERS.format(commit=commit)).decode("utf-8")
    characters_start = re.search(r"export\s+default\s*", characters_text)
    if not characters_start:
        raise ValueError("character_list.ts has no default export")
    dating = build_bd2_dating(parse_js_literal(characters_text, characters_start.end())[0])
    sources |= {scene["skeleton"] for scene in dating.values()}
    # Every external skeleton and scene must exist at the asset commit the roster pins.
    asset_commit = json.loads(BD2_CATALOG.read_text(encoding="utf-8"))["commit"]
    for source in sorted(sources):
        request(BD2_ASSET_RAW.format(commit=asset_commit) + source + ".skel", {"Range": "bytes=0-15"})
    previous = json.loads(BD2_PERFORMANCES.read_text(encoding="utf-8")) if BD2_PERFORMANCES.exists() else {}
    if previous.get("costumes") == costumes and previous.get("dating") == dating:
        return BD2_PERFORMANCES, dump(previous)
    return BD2_PERFORMANCES, dump({"generatedAt": now(), "source": f"{BD2_VIEWER_REPO}@{commit[:12]}",
                                   "license": "MIT", "commit": commit, "costumes": costumes, "dating": dating})


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


def is_shown(outfit_id: str, english: str, chinese: str = "") -> bool:
    parsed = parse_id(outfit_id)
    if not parsed or outfit_id in NIKKE_EXCLUDED:
        return False
    number = int(parsed[0])
    if number >= 900 or 250 <= number <= 259 or 300 <= number <= 308:
        return False
    if NIKKE_EXCLUDED_NAMES.search(english) or NIKKE_EXCLUDED_NAMES.search(chinese):
        return False
    return not english.lower().endswith("_old")


def split_name(name: str) -> tuple[str, str]:
    """Person and variant, separated by a full- or half-width colon."""
    parts = [part.strip() for part in re.split(r"[：:]", name, maxsplit=1)]
    return parts[0], parts[1] if len(parts) > 1 else ""


def skin_name(own: str, parent: str, person: str) -> str:
    """The outfit's own words after its base unit's name ("拉毗 白色诺言" -> "白色诺言")."""
    for prefix in (parent, person):
        if prefix and own.startswith(prefix):
            return own[len(prefix):].strip(" ：:")
    return own.strip()


def outfit_files(paths: set[str], outfit_id: str) -> dict:
    """Stand, cover and aim files present in the l2d tree for one outfit."""
    files = {}
    # A few standalone models (c570_99) name the stand files after the folder alone.
    for mode, stems in (("stand", (f"{outfit_id}/{outfit_id}_00", f"{outfit_id}/{outfit_id}")),
                        ("cover", (f"{outfit_id}/cover/{outfit_id}_cover_00",)),
                        ("aim", (f"{outfit_id}/aim/{outfit_id}_aim_00",))):
        stem = next((stem for stem in stems if f"{stem}.skel" in paths and f"{stem}.atlas" in paths), None)
        if stem:
            files[mode] = {"skeleton": f"l2d/{stem}.skel", "atlas": f"l2d/{stem}.atlas"}
    return files


def build_nikke(tree_paths: set[str], index: list, names: dict, versions: dict, skipped: list | None = None) -> list:
    """Group outfits into people. versions maps skeleton path -> runtime.

    Base units (cNNN) need a Chinese name, from names or the index's cn field;
    without one they are left out and reported, since the index leaves male
    characters unnamed. Skins (cNNN_NN) join their base unit's person and are
    labelled by the words after its name, or by English when they have none.
    """
    english = {entry["id"]: str(entry.get("name") or "") for entry in index if isinstance(entry, dict) and entry.get("id")}
    chinese = {entry["id"]: str(entry.get("cn") or "") for entry in index if isinstance(entry, dict) and entry.get("id")}
    chinese.update({key: value for key, value in names.items() if value})
    outfits = sorted({path.split("/")[0] for path in tree_paths if parse_id(path.split("/")[0])})
    people: dict[str, dict] = {}
    units: dict[str, tuple[str, str]] = {}  # base id -> (person, unit label)
    for outfit_id in outfits:
        files = outfit_files(tree_paths, outfit_id)
        if "stand" not in files or not is_shown(outfit_id, english.get(outfit_id, ""), chinese.get(outfit_id, "")):
            continue
        number, suffix = parse_id(outfit_id)
        base = f"c{number}"
        own = chinese.get(outfit_id, "")
        if suffix and base in units:
            person, unit = units[base]
            if own:
                skin = skin_name(own, chinese.get(base, ""), person)
            else:
                skin = skin_name(english.get(outfit_id, ""), english.get(base, ""), "") or f"未命名时装 {outfit_id}"
            label = " ".join(part for part in (unit, skin) if part)
        elif own:
            person, label = split_name(own)
            if not suffix:
                units[outfit_id] = (person, label)
        else:
            if skipped is not None:
                skipped.append(outfit_id)
            continue
        entry = people.setdefault(person, {"id": f"nikke:{outfit_id}", "name": person,
                                           "aka": split_name(english.get(outfit_id, ""))[0].replace("_", " "), "costumes": []})
        costume = {"label": label or "默认", "outfit": outfit_id}
        # The combat loop moves between the cover and aim skeletons; without a
        # cover skeleton it stays on the aim pose.
        parts = [("idle", files["stand"]), ("cutscene", files.get("aim"))]
        if "aim" in files and "cover" in files:
            parts.append(("cover", files["cover"]))
        for mode, part in parts:
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
    names_commit = get_json(f"https://api.github.com/repos/{NIKKE_NAMES_REPO}/commits/main")["sha"]
    index = get_json(NIKKE_NAMES_INDEX.format(commit=names_commit))
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
        print(f"nikke: {len(skipped)} outfits without a Chinese name left out "
              f"(male characters, server-only entries or not yet named upstream; "
              f"add a name in {NIKKE_NAMES.relative_to(ROOT)} to show one): "
              + ", ".join(skipped))
    previous = json.loads(NIKKE_CATALOG.read_text(encoding="utf-8")) if NIKKE_CATALOG.exists() else {}
    if previous.get("characters") == characters:
        # Unrelated upstream commits (story art, galleries) keep the pinned commit.
        return NIKKE_CATALOG, dump(previous)
    return NIKKE_CATALOG, dump({"generatedAt": now(), "source": f"{NIKKE_REPO}@{commit[:12]}",
                                "names": f"{NIKKE_NAMES_REPO}@{names_commit[:12]}",
                                "commit": commit, "characters": characters})


# --- Azur Lane ---------------------------------------------------------------

AZURLANE_MODEL = re.compile(r"Live2D/([^/]+)/\1\.model3\.json")


def azurlane_models(tree_paths: set[str]) -> list[str]:
    """Model folders that hold a model3.json and moc3 named after the folder."""
    return sorted(match.group(1) for path in tree_paths if (match := AZURLANE_MODEL.fullmatch(path))
                  and f"Live2D/{match.group(1)}/{match.group(1)}.moc3" in tree_paths)


def build_azurlane(models: list[str], skins: dict, ships: dict, skipped: list | None = None) -> list:
    """Group skins into people by their ship's Chinese name.

    skins maps a ship's painting name to {skin painting: {"name": ...}} and
    ships maps it to {"name": ...}, as in Pelom777/AzurLaneData. Painting names
    are matched without case; a skin painted as the ship itself is its default.
    """
    owners = {painting.lower(): (ship, str(skin.get("name") or ""))
              for ship, entries in skins.items() for painting, skin in entries.items()}
    folders = {model.lower() for model in models}
    people: dict[str, dict] = {}
    for model in models:
        painting = model.lower()
        if painting.endswith("_hx"):
            # Censored copies made for the Chinese release; prefer the original.
            if painting[:-3] in folders:
                continue
            painting = painting[:-3]
        owner = owners.get(painting)
        person = owner and str(ships.get(owner[0], {}).get("name") or skins[owner[0]].get(owner[0], {}).get("name") or "")
        if not person:
            if skipped is not None:
                skipped.append(model)
            continue
        ship, skin = owner
        entry = people.setdefault(person, {"id": f"azurlane:{ship.lower()}", "name": person, "costumes": []})
        part = {"model": f"Live2D/{model}/{model}.model3.json", "runtime": "live2d"}
        # One model serves both displays: idle for the portrait, its reactions for the action.
        entry["costumes"].append({"label": "默认" if painting == ship.lower() else skin or model,
                                  "outfit": model, "idle": part, "cutscene": part})
    characters = sorted(people.values(), key=lambda person: person["id"])
    for person in characters:
        person["costumes"].sort(key=lambda costume: (costume["label"] != "默认", costume["outfit"].lower()))
    return characters


def update_azurlane() -> tuple[Path, str]:
    api = "https://api.github.com/repos/"
    commit = get_json(api + AZURLANE_REPO + "/commits/main")["sha"]
    tree = get_json(f"{api}{AZURLANE_REPO}/git/trees/{commit}?recursive=1")
    if tree.get("truncated"):
        raise ValueError("AzurLaneLive2D tree was truncated")
    models = azurlane_models({item["path"] for item in tree["tree"]})
    names_commit = get_json(api + AZURLANE_NAMES_REPO + "/commits/main")["sha"]
    skins = get_json(AZURLANE_NAMES.format(commit=names_commit, table="skin"))
    ships = get_json(AZURLANE_NAMES.format(commit=names_commit, table="ship"))
    skipped: list[str] = []
    characters = build_azurlane(models, skins, ships, skipped)
    if not characters:
        raise ValueError("no Azur Lane Live2D model could be named")
    if skipped:
        print(f"azurlane: {len(skipped)} models without a Chinese name left out "
              f"(not yet in {AZURLANE_NAMES_REPO}): " + ", ".join(skipped))
    previous = json.loads(AZURLANE_CATALOG.read_text(encoding="utf-8")) if AZURLANE_CATALOG.exists() else {}
    if previous.get("characters") == characters:
        return AZURLANE_CATALOG, dump(previous)
    return AZURLANE_CATALOG, dump({"generatedAt": now(), "source": f"{AZURLANE_REPO}@{commit[:12]}",
                                   "names": f"{AZURLANE_NAMES_REPO}@{names_commit[:12]}",
                                   "commit": commit, "characters": characters})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", choices=["bd2", "nikke", "azurlane", "all"], default="all")
    parser.add_argument("--check", action="store_true", help="report changes without writing")
    args = parser.parse_args()
    updates = [update for game, update in (("bd2", update_bd2), ("bd2", update_bd2_performances),
                                           ("nikke", update_nikke), ("azurlane", update_azurlane))
               if args.game in (game, "all")]
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
