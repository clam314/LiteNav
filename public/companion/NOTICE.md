# 角色资源来源

角色陪伴目前收录《棕色尘埃 2》《NIKKE：胜利女神》与《碧蓝航线》三个来源，各份角色目录都固定在上游的某次提交上，并由 `scripts/update_companion.py` 每周自动刷新（`.github/workflows/companion-catalogs.yml`）。以下先说明棕色尘埃 2，NIKKE 与碧蓝航线见文末。

此目录包含角色索引 `catalog.json`，以及一套本地待机后备资源：**悠丝缇亚（Justia）· 血骑士**，资源 ID `char000201`。随机角色及技能使用索引中的素材路径，只在选中时从固定版本的上游按需加载；没有将全部角色、技能或声音素材打包进项目。

## 参考页面与索引

- 参考页面：<https://clam314.github.io/bd2web/characters.html>
- 页面源码：<https://github.com/clam314/bd2web/blob/main/characters.html>
- 角色索引：<https://github.com/clam314/bd2web/blob/main/data/roster.json>
- 本地索引：`catalog.json`，保留上游的角色、服装、立绘 (`idle`)、技能 (`cutscene`) 与背景 (`bg`) 字段；某些服装缺少立绘或技能，值为 `null`，不能假定每套服装都支持全部展示方式。
- 本地后备素材：索引内角色 `0002` / `悠丝缇亚` / `Justia` 的 `血骑士` 服装，使用其 `idle` 部分。

角色索引于 2026-11-16 取得，上游生成时间为 `2026-11-14T01:15:41+00:00`，上游原始索引包含 89 位角色、209 套服装。索引、按需角色素材及本地后备的三个素材文件均固定使用 `424622b8c4fd`，未使用浮动的最新素材地址。

## 游戏素材

来源仓库：<https://github.com/myssal/Brown-Dust-2-Asset>。

按需素材的固定提交：[`424622b8c4fd`](https://github.com/myssal/Brown-Dust-2-Asset/tree/424622b8c4fd)。素材路径保留索引中的原始大小写；Atlas 可能引用多张纹理，应按其实际页面列表加载。技能使用独立的 `spine/cutscenes/` 骨架，并非立绘骨架中的 `motion` 动作。首次加载尚未缓存的远程素材需要联网；本地后备立绘无需外网。

本地后备于 2026-11-17 替换为悠丝缇亚「血骑士」，与角色索引使用相同固定提交 `424622b8c4fd`，原始文件：

- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/424622b8c4fd/spine/char/char000201/char000201.skel>
- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/424622b8c4fd/spine/char/char000201/char000201.atlas>
- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/424622b8c4fd/spine/char/char000201/char000201.png>

三个文件均保持下载时的原始字节。Atlas 引用同目录下唯一的 `char000201.png`（2048 × 512），没有额外纹理依赖。上游 README 原文保存于 `assets/README.upstream.md`；在所选提交的仓库根目录中未发现独立的素材许可证。资源来源于《棕色尘埃 2》，相关权利仍归原权利人所有；此收录没有赋予再发布或商业使用权。当前集成用途为用户授权的私人本地导航页，未发布站点。

## 图鉴动作与取景预设

`gamekee-presets.json` 于 2026-11-16 从 [GameKee 角色图鉴](https://www.gamekee.com/zsca2/718485?tab=fzjn&style=style2) 的公开[角色数据索引](https://api-cdn.gamekee.com/wiki2.0/pro/50118/bd2roles/data.json?v=20261110174946.028047) 整理，仅保存动作名称、姓名、服装和 PC 大图取景参数，不收录该站媒体文件。每条预设保留对应图鉴页的来源链接。

预设按立绘和技能的实际素材文件名分别匹配。2026-11-17 补入图鉴 `honor_live2d` 中的 17 套尊爵服装后，共覆盖 178 套服装、166 项立绘和 249 项技能展示配置。尊爵服装使用各自的骨架、取景及文章中的服装名，菜单保留原有编号。布莱德服装 93 的图鉴第二项填写了技能骨架中缺少的 `idle`，菜单只收录可播的 `loop_2`。完全缺少有效配置的服装按骨架回退。一条把英格利得指向斐杰素材的冲突记录已跳过。运行时从本地读取预设。

[席比雅「剑后」](https://www.gamekee.com/zsca2/593588?tab=fzpc&style=style3) 的普通立绘为 `char001002`，尊爵立绘为 `char001092`。图鉴在待机 5 秒后播放一次骨架的 `motion` 再恢复待机，尊爵剑后的这段动作持续 4 秒。

[莉亚特里斯「女仆代号R」](https://www.gamekee.com/zsca2/593608?tab=fzjn&style=style3) 的 `char001297` 将人物与搅拌道具分别导出到 `loop` 和 `loop_bowl`。预设的 `attachmentLayers` 来自对固定版本骨架的核对，用于在同一骨架上恢复配套附件及其显隐关键帧。`framing: "full"` 是本项目为这段搅拌动作选择的完整取景，包含人物、双手和道具。另一镜头 `loop_2` 使用图鉴取景。

[艾尼尔「穿透魔弓」](https://www.gamekee.com/zsca2/593632?tab=fzjn&style=style1) `char061101` 的技能 `loop` 在图鉴取景（`viewport`，x 为 -550～20）中只框住弓与手臂，人物的脸（x 约 -94～231）落在右侧之外。本项目为它补充了 `localViewport`（x 为 -400～460，高度与底边同图鉴），运行时优先使用，原始图鉴数值保留不变。

参考页的阿奇拉·被封印的欲望对应 `char067902`，技能展示默认循环 `loop_2`，另一展示动作循环 `loop`；两者使用不同的手工取景。图鉴中的这些动态展示与游戏内完整技能录像不同，不应把导出的 `cut_A`、`cut_B` 等片段拼成一场演出播放，原因见下一节。

## 叠播循环与有缘之客

`bd2-performances.json` 由 `scripts/update_companion.py` 从 [Jelosus2/BD2-L2D-Viewer](https://github.com/Jelosus2/BD2-L2D-Viewer)（MIT 许可，许可证原文保存为 `LICENSE.bd2-l2d-viewer`）的固定提交生成，记录所用提交。脚本把上游 TypeScript 文件当作数据解析（只接受对象、数组、字符串、数字等字面量），不执行其中任何代码。

- **技能的叠播循环**（`costumes`）：取自 `src/utils/cutscene_mappings.ts`，是作者为 155 套服装的技能骨架手工编排的组合：分段先后播放（`playDuration` 截短、`offset` 延后），拆开的部位（身体、头、马尾、光效）在同一阶段各用一份骨架同时叠播（`layerOrder` 决定前后，`hold`、`loop` 撑到阶段结束），个别部位借用另一套骨架（`source`，按 `spine/cutscenes/<名称>/<名称>` 在本页固定的素材提交中读取，更新时逐一核对存在）。本页只采用其中给循环加上叠播部位的组合（如 `loop_2_all`），用来替换技能菜单里原来那一项，目前有 7 套服装。
  - **不采用完整演出**：编排里的 `cut_all` 等是整场技能演出，曾于 2026-11-19 接入后撤下。这些分段是为游戏的技能场景构图的，游戏同时播放战斗背景、粒子与后期效果，它们不在公开的骨架素材里；单独播放时会出现只画到腰部的人物、悬空的部件等缺损（例如米卡艾拉「海滨正义 · 服装 91」的群像镜头）。BD2-L2D-Viewer 自身的播放效果相同，无法在本页补全。数据仍随上游一起更新，供日后参考。
- **有缘之客**（`dating`）：取自 `src/utils/character_list.ts` 的 `dating` 字段，21 套服装对应 `spine/illust/illust_dating/` 下的场景骨架。游戏里需要按攻略点触推进，本页没有点触，因此按一个固定流程巡游：随机轮换时，有场景的服装在「动作」展示中播放这个场景；固定人物时默认播放技能循环，可在技能菜单中选择「有缘之客」。巡游流程为每个阶段循环 `idleN`，按随机顺序把该阶段的全部触摸反应各播一次（`mixN_n_k` 按段依次叠在待机上，`datingUsesTracks` 时用第二条轨道；各阶段有 1–48 段，合计可达 4 分钟），再播放转场 `motionN_*` 进入下一阶段，最后一阶段结束后从头开始。同一阶段有多个转场时（如奥利维尔「传奇退役」的 `motion1_15`–`motion1_17`），它们起止姿势相同，是可替换的版本，只播编号最小的一个。「轮流」和随机换人在两段之间（人物回到待机时）离开场景，「轮流」至少播放 30 秒；页面打开期间，下次回到同一套服装时从离开时的阶段继续，只播还没播过的反应，此前各阶段转场的最终姿势会先摆好。部分场景另有 `loop`、`01` 等动画，它们是与待机大部分重合的整套姿势，不属于反应或转场，不播放。场景以原点为中心，每个阶段按其待机取景：四周有黑框部件（名称含 `black`、`BK`、`fr`）围出窗口时取这个窗口；否则取覆盖原点的最大部件（场景画面），比其余所有部件在宽、高上都大 2.5 倍以上的纯黑底板，以及覆盖原点、与画面一样大的黑框，会被隐藏且不参与取景；没有场景画面时按人物取景。安洁莉卡「霓虹救星」等场景的默认皮肤不含画面，此时各阶段换用自己的皮肤（如 `idle1_1`、`idle3_1`）。反应的选择是随机的，不代表游戏中的攻略流程。

素材的大小写：`cutscene_char000203`、`cutscene_char001201` 两套技能骨架的 atlas 引用小写的 `cutscene_char…png`，仓库中的文件却是 `CutScene_Char…png`；运行时按骨架文件名的大小写读取这类纹理。

## Spine 运行时

`/vendor/spine/spine-player-4.1.56.js` 和 `.css` 直接下载自参考站仓库 `vendor/` 目录，保持原始字节：

- <https://raw.githubusercontent.com/clam314/bd2web/main/vendor/spine-player-4.1.56.js>
- <https://raw.githubusercontent.com/clam314/bd2web/main/vendor/spine-player-4.1.56.css>

Spine 运行时由 Esoteric Software 提供，受 **Spine Runtimes License Agreement** 约束。官方 `4.1` 分支的许可证原文保存于 `/vendor/spine/LICENSE`：<https://github.com/EsotericSoftware/spine-runtimes/blob/4.1/LICENSE>。该许可证包含 Spine Editor 许可要求，使用时需遵守其条款。

参考站 README 原文保存于 `/vendor/spine/README.bd2web.md`，其中说明这是非官方学习展示项目，并要求不要公开传播游戏素材。

## 本地验证

- 使用上述下载的 4.1.56 运行时解析二进制骨架成功；骨架导出版本为 **4.1.11**。
- 本地后备骨架的实际动画为 `idle`（4 秒）和 `motion`（约 1.33 秒）；其他角色和技能应读取各自骨架中的实际动画列表，不能沿用此命名。
- 本地后备取景直接采用 `gamekee-presets.json` 中 `char000201` 的公开图鉴立绘预设：`x=-449.5153575336905`、`y=-582.167319089905`、`width=820`、`height=1020`，四边留白均为 `5%`；来源为[悠丝缇亚「血骑士」图鉴](https://www.gamekee.com/zsca2/593571?tab=fzjn&style=style1)。
- Atlas 的 `pma` 标记为 `false`，使用透明画布及非预乘透明度。
- 已检查 PNG 签名、2048 × 512 尺寸及全部 PNG 块 CRC，已检查 Atlas 纹理引用齐全；下载文件均非 HTML 错误页。

SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `char000201.skel` | `ca6053cfe940ae1103566bc98730e627688101729e2cba27539f32537f8f01dc` |
| `char000201.atlas` | `6cd6fa70c01e00e6a258935ee51addb047b31081912cf66d7acdd9dca86a6c5d` |
| `char000201.png` | `843615cb5f071bca8374faf97999ecfdaef8e636ea545d1ad86b3ed13344c038` |
| `spine-player-4.1.56.js` | `28d83fdbae0af5965d568d9607e9e20710dcce8b984c0a24e9d2a1d0915938bc` |
| `spine-player-4.1.56.css` | `2ce8e4f63557164fa77205aa4469c74950cf834f1ac91c222d794e6e66ae7e0c` |
| `spine-player-4.0.30.js` | `06eaacbe8fc6da5b03df1d5642130603794e15bcd8ea99319473d10abc7ef741` |

## 持续更新

`scripts/update_companion.py` 只使用 Python 标准库，可在本地运行，也由 GitHub Actions 每周一自动运行；有变化时提交到 `main` 并重新构建镜像。

- 棕色尘埃 2：读取 [clam314/bd2web](https://github.com/clam314/bd2web) 的 `data/roster.json`。该名册由作者随上游素材仓库同步，本项目原样使用并校验其固定提交与角色列表。
- NIKKE：见下一节。
- 碧蓝航线：见文末一节。

## NIKKE：胜利女神

- 素材来源：[Nikke-db/Nikke-db.github.io](https://github.com/Nikke-db/Nikke-db.github.io)，目录 `nikke/catalog.json` 固定其某次提交，只在选中时按需加载 `l2d/` 下的立绘（`{id}_00`）与瞄准（`aim/{id}_aim_00`）骨骼，未打包任何素材。上游仅有剧情图等无关提交时沿用原固定提交。
- 时装以上游 `l2d` 文件树中实际存在的骨骼为准；素材仓库自带的旧索引 `js/json/l2d.json` 漏收了部分时装（例如 `c016_03`），不再使用。每个骨骼的 Spine 版本读取自文件头，4.0 与 4.1 素材分别由对应运行时播放。
- 名字：取自 Nikke-db 为其网站维护的 [nikke-db-vue](https://github.com/Nikke-db/nikke-db-vue) `src/utils/json/l2d.json`，与素材同步更新，含简体中文（`cn`）与英文名，目录记录所用提交。基础角色按「人物：型号」拆分，时装取基础角色名之后的部分；没有中文名的时装按英文名拆分，仍无名则显示「未命名时装」。人物必须有中文名才收录：该索引不为男性角色和部分服务器专属条目提供中文名，这类编号会在更新时列出。`scripts/nikke-names.json` 可手工指定名字并优先于索引（此前取自 [clam314/Nikkiweb](https://github.com/clam314/Nikkiweb) 的名称表已全部被索引覆盖）。目前只有一条：方舟黑色游侠的独立模型 `c570_99`（文件直接以文件夹命名，`c570_99/c570_99.skel`，只有立绘）在索引中没有中文名，本项目按其兜帽、面罩外观命名为「兜帽装束」。
- 不展示：NPC（`c9xx`）、量产型敌人（`c250`–`c259`）、士兵、产品与 iDoll（`c300`–`c308`，并按「士兵／产品／iDoll」等名字匹配）、旧版模型（英文名以 `_old` 结尾）以及联动男性角色电次、早川秋、9S、亚当。
- 部分立绘需要指定皮肤（`acc`、`bg`），名单沿用 Nikkiweb。另有骨骼把头、手臂等部件拆在 `part_0`、`part_1` 等额外皮肤里，默认皮肤并不完整（例如方舟黑色游侠 `c570` 的掩体与瞄准骨骼）；运行时会把能补上缺失起始部件的皮肤合并进来。
- 展示方式：立绘播放站立骨骼的 `idle`；「动作」为战斗循环，参照 Nikkiweb 的「开火循环展示」在掩体（`cover/{id}_cover_00`）与瞄准骨骼之间切换：掩体待机 → `to_aim` → 瞄准 → `aim_fire` 连射（叠加 `aim_fire_hair`、`aim_fire_hip`，有技能射击时接着播放）→ `to_cover` → 掩体待机 → `cover_reload` 换弹，循环往复。两套骨骼共用同一取景，过渡动作在离开的那套骨骼上播放；没有掩体骨骼的时装只在瞄准姿势上开火。
- NIKKE 部分 atlas 的区域名含韩文。运行时以纯文本 data URI 交给 Spine，避免其 `atob` 解码破坏 UTF-8。

Spine 4.0 运行时 `/vendor/spine/spine-player-4.0.30.js` 下载自官方 npm 包 [`@esotericsoftware/spine-player@4.0.30`](https://www.npmjs.com/package/@esotericsoftware/spine-player/v/4.0.30)（`dist/iife/spine-player.js`），保持原始字节；其样式与 4.1.56 版完全相同，共用同一份 CSS。许可证同样为上文的 Spine Runtimes License Agreement。

素材相关权利归 SHIFT UP 及原权利人所有。此收录仅用于个人学习与展示，不用于商业用途。

## 碧蓝航线

- 素材来源：[bungaku-moe/AzurLaneLive2D](https://github.com/bungaku-moe/AzurLaneLive2D)，目录 `azurlane/catalog.json` 固定其某次提交，只在选中时按需加载 `Live2D/{名称}/` 下的模型，未打包任何素材。每个 `{名称}.model3.json` 与同名 `.moc3` 构成一套皮肤；国服的和谐版本（`_hx`）在原版存在时不收录。上游仅有无关提交时沿用原固定提交。
- `.moc3` 与贴图存放在 Git LFS 中，`raw.githubusercontent.com` 只返回指针文件，因此改从 `media.githubusercontent.com/media/…` 按同一固定提交读取；`model3.json`、物理与动作文件仍从 raw 读取。LFS 下载计入上游仓库的流量额度，额度用尽时 GitHub 会暂停其下载。
- 名字：舰船与皮肤的中文名取自 [Pelom777/AzurLaneData](https://github.com/Pelom777/AzurLaneData) 的 `public/data/ship.json` 与 `skin.json`（每小时从国服客户端重新生成），按立绘名（不区分大小写）对应，目录记录所用提交。立绘名与舰船同名的皮肤显示为「默认」；同名舰船（例如天城与天城·航母）合并为一位人物。数据源暂未收录的新模型会在更新时列出并跳过。
- 展示方式：立绘循环模型的 `idle` 动作；「互动」按随机顺序依次播放主界面与触摸动作（`home`、`login`、`mail`、`mission`、`mission_complete`、`complete`、`touch_head`、`touch_body`、`touch_special`、`main_N`），每段之间回到 `idle` 约 1.5 秒。L2D+ 模型的拖拽状态（`idleN`、`touch_idleN`、`touch_dragN`）与誓约动作 `wedding` 不播放。多数模型自带的 `effect`（飘带、光效等环境动画）在单独的动作队列上与其他动作同时循环。动作用 PartOpacity 曲线切换互斥的部件（持扇与垂下的手臂、吉祥物的两种姿势等），框架默认把这些曲线写进同名参数而不生效，本页打开 `CubismConfig.setOpacityFromMotion` 让它们直接作用于部件；每帧先把部件恢复为模型自带的不透明度，再由动作切换，因此互动动作切换过的部件不会残留到待机。两种展示中，模型的视线与头部都会跟随页面上的鼠标指针（距离越远转得越多，最多到模型幅度的八成），指针离开窗口后回到正前方；台词与语音不播放。
- 取景：在 8 秒的 `idle` 中采样可见网格的范围（限制在模型画布内，并排除 `Touch` 开头的触摸判定网格，部分模型把它们放在画布外很远处），按此范围填满侧栏高度、贴住底边，水平居中于导航留出的空白区域。带整幅场景的模型会超出两侧，左侧由侧栏渐隐遮住。

### 动态立绘

- 素材来源：[ww-rm/azurlane_spinepainting](https://github.com/ww-rm/azurlane_spinepainting)，目录记录其固定提交（`paintingCommit`），只在选中时按需加载 `docs/<舰船>/<皮肤>/` 下的文件。仓库索引 `docs/index.json` 共 141 套皮肤，每套由一至七层 Spine 3.8.99 骨架组成（人物、背景、道具等）。名字同样取自 Pelom777/AzurLaneData，索引中缺失的（如领洋者「入浴的小恶魔」）沿用索引自带的中文名；舰船自身的立绘显示为「默认」，改造显示为「改造」。同一皮肤另有 Live2D 或多种形态时，动态立绘一项标注「（动态立绘）」。
- 展示方式：参照其作者的[网页播放器](https://ww-rm.github.io/azurlane/)：图层按索引顺序叠放，第一层在最上；去掉文件名以 `_hx` 结尾的和谐图层；各层同时循环 `normal`（没有时用 `idle`，再没有时用最后一个动作）。取景为各层在循环中可见部件的范围，与 Live2D 一样填满侧栏高度、贴住底边，并水平居中于导航留出的空白区域。
- 互动动作：上游没有动作说明，名称各套不同，因此由 `scripts/azurlane-painting-actions.json` 手工列出带反应的 16 套（埃姆登、高雄、樫野、凯尔圣、莱姆号、特立尼达、莫里森的拖拽 `drag → ex → drag_ex`，莫里森另有两种触摸反应；伊404 两种形态与能代的 `login`；建武、四万十、苏维埃同盟的 `login` 与 `touch_*`；冒险号、维达号、亚尔薇特的点击反应）。更新脚本校验名称并在皮肤从索引消失时提示。只有这些立绘出现在「互动」与「轮流」中：每个反应依次在拥有该动作的图层上播放，之后回到循环约 1.5 秒再播下一个，顺序随机。互动展示的取景同时覆盖循环与各个反应，大幅动作（如高雄的舰体爆发）不会被裁掉，人物因此比立绘展示略小。编号动作（`1`…`N`）、`xunhuan`、`zhayan`、`change_out` 等未确认含义的动作不播放。
- 运行时：`/vendor/spine/spine-webgl-3.8.js` 下载自官方仓库 3.8 分支的固定提交 [`8b4844bd4b19`](https://github.com/EsotericSoftware/spine-runtimes/blob/8b4844bd4b193ba9e54487ed397a777993cbad56/spine-ts/build/spine-webgl.js)，保持原始字节；许可证原文（3.8 分支版本）保存为 `/vendor/spine/LICENSE-3.8`。3.8 版没有本页使用的播放器回调，因此由 `companion-painting-player.js` 直接调用其 WebGL 渲染器。该版本的全局对象 `spine` 会并入已有的同名对象，载入时先清空全局、载入后恢复，避免与 4.1 运行时混合。
- 3.8 的二进制读取器按有符号字节解码 UTF-8 名称，中文区域名会变成乱码而在 atlas 中找不到（例如怨仇的背景层）。本页不修改运行时，而是在查找区域时把乱码还原为原本的 UTF-8 名称再查一次；另有个别导出在区域名末尾带空格（苏维埃同盟「缠丝审讯」），也一并去掉后再查。

| 文件 | SHA-256 |
| --- | --- |
| `spine-webgl-3.8.js` | `4b108bad314c152bf0ff7a7f56fce5c98073f05a2bfa53e880d6c24b6f7c3aa5` |

### Live2D 运行时

均保持下载时的原始字节，存放于 `/vendor/live2d/`：

- `live2dcubismcore.min.js`：Live2D Cubism Core 5.1.0（`05.01.0000`），下载自官方地址 <https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js>。该文件是 [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) 中的 Redistributable Code，使用须遵守该协议；个人及小规模用途另见 Live2D 的 SDK 发布许可。
- `pixi-6.5.10.min.js`：[PixiJS](https://github.com/pixijs/pixijs) 6.5.10（npm `pixi.js@6.5.10` 的 `dist/browser/pixi.min.js`），MIT 许可，原文见 `LICENSE.pixijs`。
- `pixi-live2d-display-0.4.0-cubism4.min.js`：[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) 0.4.0（npm 包的 `dist/cubism4.min.js`），MIT 许可，原文见 `LICENSE.pixi-live2d-display`。其中打包的 Cubism 4 Framework 受 [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html) 约束。

该版本的框架把编译好的着色器作为单例在所有 WebGL 上下文间共用，切换人物时新旧两个画布同时存在会使旧画布变成空白。运行时（`companion-live2d-player.js`）为每个上下文单独保存一套着色器，未修改上述文件。

本地验证：上游 271 个模型的 `.moc3` 格式版本分布为 46 / 128 / 1 / 35 / 61（3.0 / 3.3 / 4.0 / 4.2 / 5.0），每种格式各取至少一个模型（Z23、雷根斯堡·暗之龙，光之岸、伴尔维·清凉的甜蜜滋味、埃吉尔·私密闲暇时、阿尔萨斯·圣宵之鬼的微醺）在页面中由 Core 5.1.0 载入并正常绘制。

| 文件 | SHA-256 |
| --- | --- |
| `live2dcubismcore.min.js` | `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f` |
| `pixi-6.5.10.min.js` | `403f2f2ee8145fa17f60c5c89403056efe2680e5096ec2762036486914ed19c5` |
| `pixi-live2d-display-0.4.0-cubism4.min.js` | `af1267e6d52759b245766c578d905bfa025b532d5c3cc727c370957c4409e21b` |

素材相关权利归蛮啾网络、勇仕网络、Yostar 及原权利人所有。上游仓库声明与上述公司无合作或背书关系。此收录仅用于个人学习与展示，不用于商业用途。
