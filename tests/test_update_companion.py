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

    def test_index_names_split_units_and_skins(self):
        paths = tree("c010", "c010_02", "c016", "c016_03", "c113", "c113_01")
        index = [{"id": "c010", "name": "Rapi", "cn": "拉毗"}, {"id": "c010_02", "name": "Rapi White Promise", "cn": "拉毗 白色诺言"},
                 {"id": "c016", "name": "Rapi: Red Hood", "cn": "拉毗：小红帽"},
                 {"id": "c016_03", "name": "Rapi: Red Hood Radiance", "cn": "拉毗：小红帽 耀光"},
                 {"id": "c113", "name": "E.H.", "cn": "E.H."}, {"id": "c113_01", "name": "E.H. Junkyard Vanguard", "cn": "E.H. 极道先锋"}]
        people = {person["name"]: person for person in self.build(paths, index=index)}
        self.assertEqual([costume["label"] for costume in people["拉毗"]["costumes"]], ["默认", "白色诺言", "小红帽", "小红帽 耀光"])
        self.assertEqual(people["拉毗"]["aka"], "Rapi")
        self.assertEqual([costume["label"] for costume in people["E.H."]["costumes"]], ["默认", "极道先锋"])

    def test_manual_names_win_over_the_index(self):
        paths = tree("c010", "c010_03")
        index = [{"id": "c010", "cn": "拉毗"}, {"id": "c010_03", "cn": "拉毗 经典假期"}]
        people = self.build(paths, index=index, names={"c010_03": "拉毗：慵懒海滩"})
        self.assertEqual([costume["label"] for costume in people[0]["costumes"]], ["默认", "慵懒海滩"])

    def test_skins_without_chinese_follow_their_person_and_unnamed_people_wait(self):
        paths = tree("c018", "c018_01", "c600", "c600_02", "c013")
        index = [{"id": "c018", "cn": "尼恩：透视之眼"}, {"id": "c600", "name": "Mint", "cn": "敏特"},
                 {"id": "c600_02", "name": "Mint"}, {"id": "c013", "name": "Marian"}]
        skipped = []
        people = self.build(paths, index=index, skipped=skipped)
        names = {person["name"]: [costume["label"] for costume in person["costumes"]] for person in people}
        self.assertEqual(names, {"尼恩": ["透视之眼", "透视之眼 未命名时装 c018_01"], "敏特": ["默认", "未命名时装 c600_02"]})
        self.assertEqual(skipped, ["c013"], "a person needs a Chinese name")

    def test_npcs_enemies_soldiers_products_idolls_males_and_old_models_are_left_out(self):
        paths = tree("c010", "c010_01", "c250", "c300", "c304", "c308", "c803", "c813", "c853", "c911", "c990")
        index = [{"id": "c010_01", "name": "Rapi_old"}, {"id": "c990", "name": "Product 12: B-0007", "cn": "新产品"}]
        names = {"c010": "拉毗", "c250": "量产型", "c300": "士兵E.G.", "c304": "iDoll花", "c308": "iDoll太阳",
                 "c803": "电次", "c813": "9S", "c853": "亚当", "c911": "NPC"}
        people = self.build(paths, index=index, names=names)
        self.assertEqual([(person["name"], len(person["costumes"])) for person in people], [("拉毗", 1)])
        for name in ("士兵O.W.", "产品23", "iDoll海", "Soldier XY", "Product 30"):
            self.assertFalse(update.is_shown("c410", name), f"{name} is matched by name outside c300-c308")

    def test_combat_outfits_carry_their_cover_skeleton(self):
        cover = lambda outfit: {f"{outfit}/cover/{outfit}_cover_00.skel", f"{outfit}/cover/{outfit}_cover_00.atlas"}
        paths = tree("c010") | cover("c010") | tree("c011", aim=False) | cover("c011")
        rapi, neon = self.build(paths, names={"c010": "拉毗", "c011": "尼恩"})
        self.assertEqual(rapi["costumes"][0]["cover"]["skeleton"], "l2d/c010/cover/c010_cover_00.skel")
        self.assertNotIn("cover", neon["costumes"][0], "a cover skeleton alone cannot form the combat loop")

    def test_standalone_models_named_after_their_folder_join_their_person(self):
        paths = tree("c570") | {"c570_99/c570_99.skel", "c570_99/c570_99.atlas", "c570_99/c570_99.png"}
        people = self.build(paths, index=[{"id": "c570", "cn": "方舟黑色游侠"}], names={"c570_99": "方舟黑色游侠：兜帽装束"})
        costumes = people[0]["costumes"]
        self.assertEqual([costume["label"] for costume in costumes], ["默认", "兜帽装束"])
        self.assertEqual(costumes[1]["idle"]["skeleton"], "l2d/c570_99/c570_99.skel")
        self.assertIsNone(costumes[1]["cutscene"])

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
