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
out when the original exists. ww-rm/azurlane_spinepainting adds the dynamic
paintings (Spine 3.8, in layers) as portraits. Pelom777/AzurLaneData, rebuilt
hourly from the Chinese server, maps each painting name to its ship and
Chinese skin name.

Destiny Child: Pelom777/DestinyChildLive2D holds the game's Live2D (Cubism 2)
models; the game ended service in 2023, so the set is complete. Each child's
model (c###_##) with an idle motion is one costume. Mobbbb/DCLive2D keeps the
client's own text tables, whose skin tables name every model (skin_character)
in English and Simplified Chinese; its hand-kept child list fills the few the
tables lack. Male characters and the story's bystanders are left out.

Every catalog pins an upstream commit, so the browser never loads moving
assets. Standard library only; set GITHUB_TOKEN to raise the API rate limit.

    python3 scripts/update_companion.py            # update every catalog
    python3 scripts/update_companion.py --game nikke   # or bd2, azurlane, destinychild
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
AZURLANE_PAINTINGS_REPO = "ww-rm/azurlane_spinepainting"
AZURLANE_PAINTINGS_INDEX = "https://raw.githubusercontent.com/" + AZURLANE_PAINTINGS_REPO + "/{commit}/docs/index.json"
AZURLANE_PAINTING_ACTIONS = ROOT / "scripts/azurlane-painting-actions.json"
# Japanese voice lines (every server ships the Japanese cast) extracted from the
# English client, keyed by skin id; the game's own skin table gives each skin's
# painting name, English server first, then Chinese. AzurLaneLuaScripts
# extracts the clients' scripts daily (AzurLaneData's JSON stopped in May 2026).
AZURLANE_VOICE_REPO = "Fernando2603/AzurLane"
AZURLANE_VOICELINES = "https://raw.githubusercontent.com/" + AZURLANE_VOICE_REPO + "/{commit}/voiceline.json"
AZURLANE_SKIN_REPO = "AzurLaneTools/AzurLaneLuaScripts"
AZURLANE_SKIN_TABLE = ("https://raw.githubusercontent.com/" + AZURLANE_SKIN_REPO +
                       "/{commit}/{server}/sharecfgdata/ship_skin_template.lua")
# One Lua table per skin; its own fields sit one tab in, nested tables deeper.
SKIN_ENTRY = re.compile(r"^_G\.pg\.base\.ship_skin_template\[(\d+)\] = \{\n(.*?)^\}", re.S | re.M)
SKIN_FIELDS = {"painting": re.compile(r'^\tpainting = "([^"\n]*)",$', re.M),
               "ship_group": re.compile(r"^\tship_group = (\d+),$", re.M),
               "id": re.compile(r"^\tid = (\d+),$", re.M)}
VOICE_LINK = re.compile(r"/audio/voiceline/(\d+)/([A-Za-z0-9_]+)\.ogg$")
# The motion a reaction plays and the voice line the game says with it.
MOTION_VOICES = {"login": "login", "home": "home", "mail": "mail", "mission": "mission",
                 "mission_complete": "mission_complete", "complete": "expedition", "touch": "touch",
                 "touch_head": "headtouch", "touch_body": "touch", "touch_special": "touch2"}
MAIN_VOICE = re.compile(r"main(\d+)")

DC_CATALOG = ROOT / "public/companion/destinychild/catalog.json"
DC_REPO = "Pelom777/DestinyChildLive2D"
DC_NAMES_REPO = "Mobbbb/DCLive2D"
# The English client's text tables, in every language it shipped: 00000008 is
# the English skin table, 00000245 the Simplified Chinese one.
DC_SKIN_NAMES = "https://raw.githubusercontent.com/" + DC_NAMES_REPO + "/{commit}/src/static/locale/{table}.tab"
DC_ENGLISH, DC_CHINESE = "00000008", "00000245"
DC_CHILDREN = "https://raw.githubusercontent.com/" + DC_NAMES_REPO + "/{commit}/src/data/childs.js"
DC_MODEL = re.compile(r"assets/live2d/(c\d{3}_\d{2})/model\.json")
# Only women and girls are shown, as in the other games. Checked against the
# client's character profiles (pronouns) and the models themselves: the
# Master (c000), male Children, and the story's men and bystanders.
DC_EXCLUDED = {
    "c000",
    "c007", "c009", "c012", "c022", "c023", "c024", "c037", "c044", "c050", "c051", "c052", "c066", "c067",
    "c069", "c072", "c082", "c085", "c090", "c107", "c110", "c112", "c121", "c125", "c131", "c132", "c147",
    "c154", "c175", "c180", "c185", "c205", "c208", "c214", "c219", "c224", "c225", "c226", "c234", "c237",
    "c266", "c286", "c289", "c299", "c302", "c315", "c317", "c319", "c346", "c362", "c412", "c413", "c425",
    "c428", "c444", "c454", "c457", "c484", "c489", "c519", "c532",
    "c257", "c322", "c325", "c326", "c327", "c328", "c330", "c331", "c352", "c369", "c515",
}
# Summon and evolution animations and the chibi model are scenes, not portraits.
DC_SCENES = re.compile(r"Animation|^SD$")
# The motions the action display plays (see companion-live2d.js).
DC_ACTION = re.compile(r"_(?:attack2?|hit|banner)\.mtn")

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


SAFE_FILE = re.compile(r"[\w.-]+")


def painting_label(person: str, skin: str, default: bool) -> str:
    """默认 for a ship's own painting, 改造 for its retrofit, else the skin name."""
    if default or skin == person:
        return "默认"
    if skin in (person + ".改", person + "·改"):
        return "改造"
    return skin


def parse_skin_table(text: str) -> dict:
    """The game's ship_skin_template as AzurLaneLuaScripts extracts it: {id: {"id", "painting", "ship_group"}}.

    The Lua is read as data, never run. Only a skin's own fields count; one
    missing a field, or whose id disagrees with its key, is left out.
    """
    rows = {}
    for entry in SKIN_ENTRY.finditer(text):
        found = {name: pattern.search(entry[2]) for name, pattern in SKIN_FIELDS.items()}
        if all(found.values()) and int(found["id"][1]) == int(entry[1]):
            rows[entry[1]] = {"id": int(entry[1]), "painting": found["painting"][1], "ship_group": int(found["ship_group"][1])}
    return rows


def azurlane_voices(tables: list[dict], voicelines: dict) -> dict:
    """Each painting's voice lines by the motion they go with: {painting: {motion: "skin/key"}}.

    tables are the game's ship_skin_template ({id: {"id", "painting", "ship_group"}}),
    earlier ones first. A painting listed under several ids (special copies in
    the 900000s besides the regular skin) is its lowest. A skin only lists the
    lines it replaces; the rest are its ship's default skin's (the lowest id of
    the group), as in the game. Lines without audio are left out.
    """
    skins: dict[str, dict] = {}
    for table in tables:
        own: dict[str, dict] = {}
        for row in table.values():
            if isinstance(row, dict) and isinstance(row.get("painting"), str) and isinstance(row.get("id"), int):
                key = row["painting"].lower()
                if key not in own or row["id"] < own[key]["id"]:
                    own[key] = row
        for key, row in own.items():
            skins.setdefault(key, row)
    defaults: dict[int, int] = {}
    for row in skins.values():
        group = row.get("ship_group")
        if isinstance(group, int) and (group not in defaults or row["id"] < defaults[group]):
            defaults[group] = row["id"]

    def lines(skin_id) -> dict:
        found = {}
        for key, entry in (voicelines.get(str(skin_id)) or {}).items():
            link = entry.get("link") if isinstance(entry, dict) else None
            match = VOICE_LINK.search(link) if isinstance(link, str) else None
            if match:
                found[key] = f"{match[1]}/{match[2]}"
        return found

    voices = {}
    for painting, row in skins.items():
        merged = {**lines(defaults.get(row.get("ship_group"))), **lines(row["id"])}
        spoken = {motion: merged[key] for motion, key in MOTION_VOICES.items() if key in merged}
        spoken.update({f"main_{match[1]}": path for key, path in merged.items() if (match := MAIN_VOICE.fullmatch(key))})
        if spoken:
            voices[painting] = spoken
    return voices


def build_azurlane(models: list[str], skins: dict, ships: dict, skipped: list | None = None,
                   paintings: dict | None = None, actions: dict | None = None, voices: dict | None = None) -> list:
    """Group skins into people by their ship's Chinese name.

    skins maps a ship's painting name to {skin painting: {"name": ...}} and
    ships maps it to {"name": ...}, as in Pelom777/AzurLaneData. Painting names
    are matched without case; a skin painted as the ship itself is its default.

    paintings is ww-rm/azurlane_spinepainting's index: {ship: {"chName",
    "skins": {skin: {"chName", "spines": [{"skelName", "atlasName", ...}]}}}}.
    Each dynamic painting is a portrait made of Spine 3.8 layers, listed top
    first; censored *_hx layers are left out. A painting the names miss uses
    the index's own names. actions maps a painting to its reactions (lists of
    animations played in order); those paintings also get an action display.
    voices (see azurlane_voices) gives a costume its voice lines, or its ship's
    default ones when the skin is newer than the skin tables.
    """
    voices = voices or {}
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
        costume = {"label": "默认" if painting == ship.lower() else skin or model,
                   "outfit": model, "idle": part, "cutscene": part}
        spoken = voices.get(painting) or voices.get(ship.lower())
        if spoken:
            costume["voices"] = spoken
        entry["costumes"].append(costume)
    for folder, ship_entry in (paintings or {}).items():
        for key, skin_entry in ship_entry.get("skins", {}).items():
            if not SAFE_FILE.fullmatch(folder) or not SAFE_FILE.fullmatch(key):
                raise ValueError(f"unexpected painting folder {folder}/{key}")
            layers = [{"skeleton": spine["skelName"], "atlas": spine["atlasName"]} for spine in skin_entry.get("spines", [])
                      if not spine["skelName"].rsplit(".", 1)[0].endswith("_hx")]
            if not layers or not all(SAFE_FILE.fullmatch(name) for layer in layers for name in layer.values()):
                raise ValueError(f"unexpected painting files in {folder}/{key}")
            owner = owners.get(key.lower())
            if owner:
                ship, skin = owner
                person = str(ships.get(ship, {}).get("name") or skins[ship].get(ship, {}).get("name") or "")
            else:
                ship, skin, person = folder, str(skin_entry.get("chName") or ""), str(ship_entry.get("chName") or "")
            if not person:
                if skipped is not None:
                    skipped.append(key)
                continue
            entry = people.setdefault(person, {"id": f"azurlane:{ship.lower()}", "name": person, "costumes": []})
            part = {"painting": f"docs/{folder}/{key}", "layers": layers, "runtime": "3.8"}
            # Most dynamic paintings only loop; the few with reactions play them as their action.
            reactions = (actions or {}).get(key)
            costume = {"label": painting_label(person, skin, key.lower() == ship.lower()),
                       "outfit": key, "idle": part, "cutscene": {**part, "actions": reactions} if reactions else None}
            spoken = voices.get(key.lower()) or voices.get(ship.lower())
            if spoken and reactions:
                costume["voices"] = spoken
            entry["costumes"].append(costume)
    characters = sorted(people.values(), key=lambda person: person["id"])
    for person in characters:
        person["costumes"].sort(key=lambda costume: (costume["label"] != "默认", costume["outfit"].lower()))
        # Double-form skins exist as Live2D and as dynamic paintings (or as two
        # paintings) under one name; the paintings say so.
        counts: dict[str, int] = {}
        for costume in person["costumes"]:
            counts[costume["label"]] = counts.get(costume["label"], 0) + 1
        for label in [label for label, count in counts.items() if count > 1]:
            forms = [costume for costume in person["costumes"] if costume["label"] == label and costume["idle"].get("painting")]
            for index, costume in enumerate(forms):
                costume["label"] = f"{label}（动态立绘{' ' + str(index + 1) if len(forms) > 1 else ''}）"
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
    painting_commit = get_json(api + AZURLANE_PAINTINGS_REPO + "/commits/main")["sha"]
    paintings = get_json(AZURLANE_PAINTINGS_INDEX.format(commit=painting_commit))
    actions = {key: value for key, value in json.loads(AZURLANE_PAINTING_ACTIONS.read_text(encoding="utf-8")).items()
               if not key.startswith("_")}
    if not all(isinstance(value, list) and value and all(isinstance(step, list) and step and
               all(isinstance(name, str) and SAFE_FILE.fullmatch(name) for name in step) for step in value)
               for value in actions.values()):
        raise ValueError(f"unexpected reactions in {AZURLANE_PAINTING_ACTIONS.name}")
    known = {key for entry in paintings.values() for key in entry.get("skins", {})}
    missing = sorted(set(actions) - known)
    if missing:
        print(f"azurlane: reactions listed for paintings the index no longer has: {', '.join(missing)}")
    voice_commit = get_json(api + AZURLANE_VOICE_REPO + "/commits/main")["sha"]
    data_commit = get_json(api + AZURLANE_SKIN_REPO + "/commits/main")["sha"]
    tables = [parse_skin_table(request(AZURLANE_SKIN_TABLE.format(commit=data_commit, server=server)).decode("utf-8"))
              for server in ("EN", "CN")]
    if not all(tables):
        raise ValueError(f"no skins could be read from {AZURLANE_SKIN_REPO}")
    voices = azurlane_voices(tables, get_json(AZURLANE_VOICELINES.format(commit=voice_commit)))
    skipped: list[str] = []
    characters = build_azurlane(models, skins, ships, skipped, paintings, actions, voices)
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
                                   "paintings": f"{AZURLANE_PAINTINGS_REPO}@{painting_commit[:12]}",
                                   "voices": f"{AZURLANE_VOICE_REPO}@{voice_commit[:12]}",
                                   "skinTable": f"{AZURLANE_SKIN_REPO}@{data_commit[:12]}",
                                   "commit": commit, "paintingCommit": painting_commit, "voiceCommit": voice_commit,
                                   "characters": characters})


# --- Destiny Child ------------------------------------------------------------

def dc_models(tree_paths: set[str]) -> dict[str, bool]:
    """Children's models with a moc, a texture and an idle motion -> whether
    they have a move for the action display."""
    folders: dict[str, set[str]] = {}
    for path in tree_paths:
        parts = path.split("/")
        if len(parts) == 4 and path.startswith("assets/live2d/"):
            folders.setdefault(parts[2], set()).add(parts[3])
    models = {}
    for model, files in folders.items():
        if DC_MODEL.fullmatch(f"assets/live2d/{model}/model.json") and \
                {"model.json", "model.moc", "texture_00.png", f"{model}_idle.mtn"} <= files:
            models[model] = any(DC_ACTION.fullmatch(name[len(model):]) for name in files if name.startswith(model))
    return dict(sorted(models.items()))


def parse_dc_skin_names(text: str) -> dict[str, tuple[str, str]]:
    """The client's skin table: model id -> (skin, character). A child's own
    look has no skin name ("_Mona"); a few entries carry a full name alone."""
    names = {}
    for line in text.lstrip("\ufeff").splitlines():
        fields = line.split("\t")
        if line.startswith("//") or len(fields) < 2 or not re.fullmatch(r"c\d{3}_\d{2}", fields[0]):
            continue
        skin, _, person = fields[1].rpartition("_")
        names[fields[0]] = (skin.strip(), person.strip())
    return names


def parse_dc_children(text: str) -> dict:
    """The hand-kept child list, a JavaScript object literal read as data."""
    start = re.search(r"CHILDS_CODE_MAP\s*=\s*", text)
    if not start:
        raise ValueError(f"no child list in {DC_NAMES_REPO}")
    children, _ = parse_js_literal(text, start.end())
    if not isinstance(children, dict):
        raise ValueError(f"unexpected child list in {DC_NAMES_REPO}")
    return children


def latin(value) -> str:
    """A name in the client's own (English) text; the child list's Chinese
    entries are mostly players' nicknames, so they are not used."""
    value = value.strip() if isinstance(value, str) else ""
    return "" if not value or value == "未知" or re.search(r"[\u3000-\u9fff\uac00-\ud7af]", value) else value


def build_destinychild(models: dict[str, bool], english: dict, chinese: dict, children: dict,
                       skipped: list | None = None) -> list:
    """One character per English name (Mona has five model codes, while
    Catherine and Katherine share a Chinese name), named in Chinese. A pact-
    maker's human form (_00) is not the child, so it is left out."""
    codes: dict[str, list[str]] = {}
    for model in models:
        if model[:4] not in DC_EXCLUDED and not model.endswith("_00"):
            codes.setdefault(model[:4], []).append(model)
    groups: dict[str, list[tuple[str, str]]] = {}
    for code, outfits in sorted(codes.items()):
        child = children.get(code) if isinstance(children.get(code), dict) else {}
        variants = child.get("variants") if isinstance(child.get("variants"), dict) else {}
        counts: dict[str, int] = {}
        for outfit in outfits:
            person = english.get(outfit, ("", ""))[1]
            if person:
                counts[person] = counts.get(person, 0) + 1
        name = max(counts, key=lambda person: counts[person]) if counts else latin(child.get("name"))
        if not name:
            if skipped is not None:
                skipped.append(code)
            continue
        for outfit in outfits:
            variant = variants.get(outfit[5:])
            title = latin(variant.get("title")) if isinstance(variant, dict) else ""
            if DC_SCENES.search(english.get(outfit, ("", ""))[0]) or DC_SCENES.search(title):
                continue
            # The client's own skin name; the child list's for a model it lacks.
            label = (chinese[outfit][0] or "默认") if outfit in chinese else title or "默认"
            groups.setdefault(name, []).append((outfit, label))
    characters = []
    for name, outfits in groups.items():
        counts = {}
        for outfit, _ in outfits:
            person = chinese.get(outfit, ("", ""))[1]
            if person:
                counts[person] = counts.get(person, 0) + 1
        costumes = [{"label": label, "outfit": outfit, "idle": part, "cutscene": part if models[outfit] else None}
                    for outfit, label in outfits
                    for part in [{"model": f"assets/live2d/{outfit}/model.json", "runtime": "live2d"}]]
        # Two looks of one name (a child's two forms) say which is which.
        for key in (lambda costume: costume["outfit"][5:], lambda costume: costume["outfit"]):
            labels = [costume["label"] for costume in costumes]
            for costume in costumes:
                if labels.count(costume["label"]) > 1:
                    costume["label"] = re.sub(r"（[^）]*）$", "", costume["label"]) + f"（{key(costume)}）"
        costumes.sort(key=lambda costume: (not costume["label"].startswith("默认"), costume["outfit"]))
        characters.append({"id": f"destinychild:{min(outfit for outfit, _ in outfits)[:4]}",
                           "name": max(counts, key=lambda person: counts[person]) if counts else name,
                           "aka": name, "costumes": costumes})
    # Two characters of one Chinese name (Catherine and Katherine) add their English one.
    shown = [person["name"] for person in characters]
    for person in characters:
        if shown.count(person["name"]) > 1:
            person["name"] += f"（{person['aka']}）"
        if person["aka"] == person["name"]:
            del person["aka"]
    return sorted(characters, key=lambda person: person["id"])


def update_destinychild() -> tuple[Path, str]:
    api = "https://api.github.com/repos/"
    commit = get_json(api + DC_REPO + "/commits/master")["sha"]
    tree = get_json(f"{api}{DC_REPO}/git/trees/{commit}?recursive=1")
    if tree.get("truncated"):
        raise ValueError("DestinyChildLive2D tree was truncated")
    models = dc_models({item["path"] for item in tree["tree"]})
    names_commit = get_json(api + DC_NAMES_REPO + "/commits/main")["sha"]
    english, chinese = (parse_dc_skin_names(request(DC_SKIN_NAMES.format(commit=names_commit, table=table))
                                            .decode("utf-8")) for table in (DC_ENGLISH, DC_CHINESE))
    if not english or not chinese:
        raise ValueError(f"no skin names could be read from {DC_NAMES_REPO}")
    children = parse_dc_children(request(DC_CHILDREN.format(commit=names_commit)).decode("utf-8"))
    skipped: list[str] = []
    characters = build_destinychild(models, english, chinese, children, skipped)
    if not characters:
        raise ValueError("no Destiny Child model could be named")
    if skipped:
        print(f"destinychild: {len(skipped)} children without a name left out: " + ", ".join(skipped))
    previous = json.loads(DC_CATALOG.read_text(encoding="utf-8")) if DC_CATALOG.exists() else {}
    if previous.get("characters") == characters:
        return DC_CATALOG, dump(previous)
    return DC_CATALOG, dump({"generatedAt": now(), "source": f"{DC_REPO}@{commit[:12]}",
                             "names": f"{DC_NAMES_REPO}@{names_commit[:12]}", "commit": commit,
                             "characters": characters})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", choices=["bd2", "nikke", "azurlane", "destinychild", "all"], default="all")
    parser.add_argument("--check", action="store_true", help="report changes without writing")
    args = parser.parse_args()
    updates = [update for game, update in (("bd2", update_bd2), ("bd2", update_bd2_performances),
                                           ("nikke", update_nikke), ("azurlane", update_azurlane),
                                           ("destinychild", update_destinychild))
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
