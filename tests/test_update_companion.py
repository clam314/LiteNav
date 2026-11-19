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


class AzurLaneCatalogTests(unittest.TestCase):
    SKINS = {
        "z23": {"z23": {"painting": "z23", "name": "Z23"}, "z23_2": {"painting": "z23_2", "name": "海风轻抚的乐园"}},
        "aersasi": {"aersasi": {"name": "阿尔萨斯"}, "aersasi_3": {"name": "圣宵之鬼的微醺"}},
        "tiancheng": {"tiancheng": {"name": "天城"}}, "tiancheng_cv": {"tiancheng_cv_3": {"name": "碧波绮尾"}},
    }
    SHIPS = {"z23": {"name": "Z23"}, "aersasi": {"name": "阿尔萨斯"}, "tiancheng": {"name": "天城"}, "tiancheng_cv": {"name": "天城"}}

    def test_models_need_their_settings_and_moc_named_after_the_folder(self):
        paths = {"Live2D/Z23/Z23.model3.json", "Live2D/Z23/Z23.moc3", "Live2D/Z23/textures/texture_00.png",
                 "Live2D/broken/broken.model3.json", "Live2D/other/model.model3.json", "Live2D/other/model.moc3"}
        self.assertEqual(update.azurlane_models(paths), ["Z23"])

    def test_skins_group_under_the_ship_name_with_the_default_first(self):
        people = update.build_azurlane(["aersasi_3", "z23_2", "Z23", "tiancheng_cv_3"], self.SKINS, self.SHIPS)
        named = {person["name"]: [(costume["label"], costume["outfit"]) for costume in person["costumes"]] for person in people}
        self.assertEqual(named, {"Z23": [("默认", "Z23"), ("海风轻抚的乐园", "z23_2")],
                                 "阿尔萨斯": [("圣宵之鬼的微醺", "aersasi_3")],
                                 "天城": [("碧波绮尾", "tiancheng_cv_3")]})
        z23 = next(person for person in people if person["name"] == "Z23")
        self.assertEqual(z23["id"], "azurlane:z23")
        part = {"model": "Live2D/Z23/Z23.model3.json", "runtime": "live2d"}
        self.assertEqual(z23["costumes"][0], {"label": "默认", "outfit": "Z23", "idle": part, "cutscene": part})

    def test_censored_copies_are_used_only_without_the_original(self):
        people = update.build_azurlane(["Z23", "z23_hx", "aersasi_3_hx"], self.SKINS, self.SHIPS)
        outfits = sorted(costume["outfit"] for person in people for costume in person["costumes"])
        self.assertEqual(outfits, ["Z23", "aersasi_3_hx"])

    def test_dynamic_paintings_join_their_ship_as_portraits(self):
        paintings = {
            "lafei": {"chName": "拉菲", "skins": {"lafei_12": {"chName": "白日慵懒", "spines": [
                {"skelName": "lafei_12T.skel", "atlasName": "lafei_12T.atlas", "pages": ["lafei_12T.png"]},
                {"skelName": "lafei_12B.skel", "atlasName": "lafei_12B.atlas", "pages": ["lafei_12B.png"]},
                {"skelName": "lafei_12_hx.skel", "atlasName": "lafei_12_hx.atlas", "pages": []}]}}},
            "z23": {"chName": "Z23", "skins": {"z23_g": {"chName": "Z23.改", "spines": [
                {"skelName": "z23_g.skel", "atlasName": "z23_g.atlas", "pages": []}]}}},
            "lingyangzhe3": {"chName": "领洋者", "skins": {"lingyangzhe3_2": {"chName": "入浴的小恶魔", "spines": [
                {"skelName": "a.skel", "atlasName": "a.atlas", "pages": []}]}}},
        }
        skins = {**self.SKINS, "z23": {**self.SKINS["z23"], "z23_g": {"name": "Z23.改"}},
                 "lafei": {"lafei": {"name": "拉菲"}, "lafei_12": {"name": "白日慵懒"}}}
        ships = {**self.SHIPS, "lafei": {"name": "拉菲"}}
        people = {person["name"]: person for person in update.build_azurlane(["Z23"], skins, ships, paintings=paintings)}
        lafei = people["拉菲"]["costumes"][0]
        self.assertEqual(lafei["label"], "白日慵懒")
        self.assertIsNone(lafei["cutscene"], "a dynamic painting is a portrait only")
        self.assertEqual(lafei["idle"], {"painting": "docs/lafei/lafei_12", "runtime": "3.8", "layers": [
            {"skeleton": "lafei_12T.skel", "atlas": "lafei_12T.atlas"},
            {"skeleton": "lafei_12B.skel", "atlas": "lafei_12B.atlas"}]}, "layers keep their order, censored ones are left out")
        self.assertEqual([costume["label"] for costume in people["Z23"]["costumes"]], ["默认", "改造"],
                         "the retrofit painting joins the Live2D default")
        self.assertEqual(people["领洋者"]["costumes"][0]["label"], "入浴的小恶魔", "the index names a painting the names miss")

    def test_double_form_paintings_say_so(self):
        paintings = {"aersasi": {"chName": "阿尔萨斯", "skins": {"aersasi_3": {"chName": "圣宵之鬼的微醺", "spines": [
            {"skelName": "aersasi_3.skel", "atlasName": "aersasi_3.atlas", "pages": []}]}}}}
        people = update.build_azurlane(["aersasi_3"], self.SKINS, self.SHIPS, paintings=paintings)
        self.assertEqual([costume["label"] for costume in people[0]["costumes"]], ["圣宵之鬼的微醺", "圣宵之鬼的微醺（动态立绘）"])

    def test_painting_paths_must_be_plain_names(self):
        for paintings in ({"../x": {"skins": {"a": {"spines": [{"skelName": "a.skel", "atlasName": "a.atlas"}]}}}},
                          {"a": {"skins": {"a": {"spines": [{"skelName": "../a.skel", "atlasName": "a.atlas"}]}}}}):
            with self.assertRaises(ValueError):
                update.build_azurlane([], self.SKINS, self.SHIPS, paintings=paintings)

    def test_models_without_a_chinese_name_are_reported(self):
        skipped = []
        people = update.build_azurlane(["Z23", "newship_2"], self.SKINS, self.SHIPS, skipped)
        self.assertEqual([person["name"] for person in people], ["Z23"])
        self.assertEqual(skipped, ["newship_2"])


class JsLiteralTests(unittest.TestCase):
    def test_reads_objects_arrays_comments_and_trailing_commas_as_data(self):
        text = """const x: Record<string, Entry> = {
          // a comment
          "103301": [{ name: "cut_all", composite: ["cut_1", { name: 'cut_2', playDuration: 1.5, hold: true }], }],
          '000101': { animations: [[ "a", "b" ]] }, /* block */
          neg: -0.5, nothing: null, no: false,
        }
        export default x"""
        start = text.index("= ") + 2
        value, end = update.parse_js_literal(text, start)
        self.assertEqual(value, {
            "103301": [{"name": "cut_all", "composite": ["cut_1", {"name": "cut_2", "playDuration": 1.5, "hold": True}]}],
            "000101": {"animations": [["a", "b"]]}, "neg": -0.5, "nothing": None, "no": False})
        self.assertTrue(text[end:].strip().startswith("export default"))

    def test_rejects_code(self):
        for text in ("{ a: foo() }", "{ a: `template` }", "{ a: 1 + 2 }", "[1, 2"):
            with self.assertRaises((ValueError, IndexError)):
                update.parse_js_literal(text)


class Bd2PerformanceTests(unittest.TestCase):
    def test_entries_become_named_definitions_with_pinned_sources(self):
        mappings = {
            "103301": [{"name": "cut_all", "composite": ["cut_1", "cut_2"]}],
            "000101": ["cut_1", "cut_2"],
            "067803": {"name": "cut_all", "animations": [[
                "cut_A", {"name": "cut_A_B", "source": "cutscene/glow/cutscene_char067803_1", "playDuration": 5}]]},
        }
        costumes, sources = update.build_bd2_performances(mappings)
        self.assertEqual(costumes["char000101"], [{"name": "all", "composite": ["cut_1", "cut_2"]}])
        glow = "spine/cutscenes/cutscene_char067803_1/cutscene_char067803_1"
        self.assertEqual(costumes["char067803"][0]["composite"][0][1]["source"], glow)
        self.assertEqual(sources, {glow})

    def test_rejects_unknown_step_options_and_sources(self):
        for mappings in ({"103301": [{"name": "x", "composite": [{"name": "a", "eval": "1"}]}]},
                         {"103301": [{"name": "x", "composite": [{"name": "a", "source": "../../etc/passwd"}]}]},
                         {"abc": ["cut_1"]}, {"103301": [{"name": "x", "composite": []}]}):
            with self.assertRaises(ValueError):
                update.build_bd2_performances(mappings)

    def test_scenes_come_from_the_character_list(self):
        characters = {"000296": {"dating": "illust_dating7", "datingUsesTracks": True},
                      "000101": {"dating": ""}, "003303": {"dating": "illust_dating1"}}
        self.assertEqual(update.build_bd2_dating(characters), {
            "char000296": {"skeleton": "spine/illust/illust_dating/illust_dating7/illust_dating7", "tracks": True},
            "char003303": {"skeleton": "spine/illust/illust_dating/illust_dating1/illust_dating1", "tracks": False}})
        with self.assertRaises(ValueError):
            update.build_bd2_dating({"000296": {"dating": "../x"}})


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
