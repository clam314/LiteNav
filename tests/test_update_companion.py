import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "update_companion.py"
spec = importlib.util.spec_from_file_location("update_companion", SCRIPT)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


def header(version: str) -> bytes:
    encoded = version.encode()
    return b"\x12\x34\x56\x78\x9a\xbc\xde\xf0" + bytes([len(encoded) + 1]) + encoded + b"\x00" * 20


def tree(*outfits, aim=True):
    paths = set()
    for outfit in outfits:
        paths |= {f"{outfit}/{outfit}_00.skel", f"{outfit}/{outfit}_00.atlas", f"{outfit}/{outfit}_00.png"}
        if aim:
            paths |= {f"{outfit}/aim/{outfit}_aim_00.skel", f"{outfit}/aim/{outfit}_aim_00.atlas"}
    return paths


def versions(paths):
    return {"l2d/" + path: "4.1" for path in paths if path.endswith(".skel")}


class SpineHeaderTests(unittest.TestCase):
    def test_reads_version_after_the_hash(self):
        self.assertEqual(update.read_spine_version(header("4.0.47")), "4.0.47")
        self.assertEqual(update.runtime_for("4.1.20"), "4.1")
        self.assertEqual(update.runtime_for("4.0.47"), "4.0")

    def test_rejects_non_spine_data(self):
        with self.assertRaises(ValueError):
            update.read_spine_version(b"\x00" * 8 + b"\x05abcd" + b"\x00" * 8)


class NikkeCatalogTests(unittest.TestCase):
    def build(self, paths, index=(), names=None, skipped=None):
        return update.build_nikke(paths, list(index), names or {}, versions(paths), skipped)

    def test_outfits_group_under_their_person_by_chinese_name(self):
        paths = tree("c010", "c010_02", "c016", "c043", "c043_01")
        names = {"c010": "拉毗", "c010_02": "拉毗：白色诺言", "c016": "拉毗：小红帽", "c043": "D", "c043_01": "D:杀手妻子"}
        people = {person["name"]: person for person in self.build(paths, names=names)}
        self.assertEqual([costume["label"] for costume in people["拉毗"]["costumes"]], ["默认", "白色诺言", "小红帽"])
        self.assertEqual(people["拉毗"]["id"], "nikke:c010")
        self.assertEqual([costume["label"] for costume in people["D"]["costumes"]], ["默认", "杀手妻子"],
                         "half-width colons also separate person and outfit")

    def test_parts_carry_paths_runtime_and_missing_aim(self):
        paths = tree("c011") | tree("c012", aim=False)
        people = self.build(paths, names={"c011": "尼恩", "c012": "阿妮斯"})
        neon, anis = people
        costume = neon["costumes"][0]
        self.assertEqual(costume["idle"], {"skeleton": "l2d/c011/c011_00.skel", "atlas": "l2d/c011/c011_00.atlas", "runtime": "4.1"})
        self.assertEqual(costume["cutscene"]["skeleton"], "l2d/c011/aim/c011_aim_00.skel")
        self.assertIsNone(anis["costumes"][0]["cutscene"], "outfits without an aim skeleton have no firing loop")

    def test_unnamed_outfits_follow_their_person_and_new_people_wait_for_a_name(self):
        paths = tree("c018", "c018_01", "c600", "c013")
        skipped = []
        people = self.build(paths, index=[{"id": "c013", "name": "Marian"}], names={"c018": "尼恩：透视之眼"}, skipped=skipped)
        names = {person["name"]: [costume["label"] for costume in person["costumes"]] for person in people}
        self.assertEqual(names, {"尼恩": ["透视之眼", "未命名时装 c018_01"], "Marian": ["默认"]})
        self.assertEqual(skipped, ["c600"])

    def test_npcs_enemies_males_and_old_models_are_left_out(self):
        paths = tree("c010", "c010_01", "c250", "c803", "c813", "c911")
        index = [{"id": "c010_01", "name": "Rapi_old"}]
        names = {"c010": "拉毗", "c250": "量产型", "c803": "电次", "c813": "9S", "c911": "NPC"}
        people = self.build(paths, index=index, names=names)
        self.assertEqual([(person["name"], len(person["costumes"])) for person in people], [("拉毗", 1)])

    def test_listed_outfits_use_their_stand_skin(self):
        paths = tree("c220", "c010")
        people = {person["name"]: person for person in self.build(paths, names={"c220": "白雪公主", "c010": "拉毗"})}
        self.assertEqual(people["白雪公主"]["costumes"][0]["idle"]["skin"], "acc")
        self.assertNotIn("skin", people["拉毗"]["costumes"][0]["idle"])
        self.assertNotIn("skin", people["白雪公主"]["costumes"][0]["cutscene"])


class Bd2RosterTests(unittest.TestCase):
    def test_accepts_a_pinned_roster(self):
        roster = {"commit": "424622b8c4fd", "characters": [{"id": "0002", "costumes": [{}]}]}
        self.assertIs(update.validate_bd2(roster), roster)

    def test_rejects_rosters_without_commit_or_characters(self):
        for roster in ({"characters": [{"id": "1", "costumes": [{}]}]}, {"commit": "424622b8c4fd", "characters": []},
                       {"commit": "424622b8c4fd", "characters": [{"id": "1", "costumes": []}]}):
            with self.assertRaises(ValueError):
                update.validate_bd2(roster)


if __name__ == "__main__":
    unittest.main()
