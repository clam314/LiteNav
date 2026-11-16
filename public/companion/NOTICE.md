# 角色资源来源

此目录包含角色索引 `catalog.json`，以及一套本地待机后备资源：**拉德尔（Lathel）· 草药猎人**，资源 ID `char000101`。随机角色及技能使用索引中的素材路径，只在选中时从固定版本的上游按需加载；没有将全部角色、技能或声音素材打包进项目。

## 参考页面与索引

- 参考页面：<https://clam314.github.io/bd2web/characters.html>
- 页面源码：<https://github.com/clam314/bd2web/blob/main/characters.html>
- 角色索引：<https://github.com/clam314/bd2web/blob/main/data/roster.json>
- 本地索引：`catalog.json`，保留上游的角色、服装、立绘 (`idle`)、技能 (`cutscene`) 与背景 (`bg`) 字段；某些服装缺少立绘或技能，值为 `null`，不能假定每套服装都支持全部展示方式。
- 本地后备素材：索引内角色 `0001` / `拉德尔` / `Lathel` 的 `草药猎人` 服装，使用其 `idle` 部分。

角色索引于 2026-11-16 取得，上游生成时间为 `2026-11-14T01:15:41+00:00`，包含 89 位角色、209 套服装。索引及按需角色素材固定使用 `424622b8c4fd`；本地后备的三个素材文件仍固定使用参考页面源码中的 `bc29e143fcdd`。两者均未使用浮动的最新素材地址。

## 游戏素材

来源仓库：<https://github.com/myssal/Brown-Dust-2-Asset>。

按需素材的固定提交：[`424622b8c4fd`](https://github.com/myssal/Brown-Dust-2-Asset/tree/424622b8c4fd)。素材路径保留索引中的原始大小写；Atlas 可能引用多张纹理，应按其实际页面列表加载。技能使用独立的 `spine/cutscenes/` 骨架，并非立绘骨架中的 `motion` 动作。首次加载尚未缓存的远程素材需要联网；本地后备立绘无需外网。

本地后备资源固定提交 `bc29e143fcdd`，原始文件：

- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/bc29e143fcdd/spine/char/char000101/char000101.skel>
- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/bc29e143fcdd/spine/char/char000101/char000101.atlas>
- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/bc29e143fcdd/spine/char/char000101/char000101.png>

三个文件均保持下载时的原始字节。Atlas 引用同目录下唯一的 `char000101.png`（2048 × 512），没有额外纹理依赖。上游 README 原文保存于 `assets/README.upstream.md`；在所选提交的仓库根目录中未发现独立的素材许可证。资源来源于《棕色尘埃 2》，相关权利仍归原权利人所有；此收录没有赋予再发布或商业使用权。当前集成用途为用户授权的私人本地导航页，未发布站点。

## 图鉴动作与取景预设

`gamekee-presets.json` 于 2026-11-16 从 [GameKee 角色图鉴](https://www.gamekee.com/zsca2/718485?tab=fzjn&style=style2) 的公开[角色数据索引](https://api-cdn.gamekee.com/wiki2.0/pro/50118/bd2roles/data.json?v=20261110174946.028047) 整理，仅保存动作名称、姓名、服装和 PC 大图取景参数，不收录该站媒体文件。每条预设保留对应图鉴页的来源链接。

通过实际素材文件名 `charNNNNNN` 匹配，且分别核对立绘与技能路径，收录当前素材索引中 161 套服装的有效预设（149 套立绘取景或动作、227 项技能动作或取景）。上游未提供的字段保持缺省，不补造参数；一条把英格利得指向斐杰素材的冲突记录已跳过。预设只在本地读取，运行时不请求 GameKee API。

参考页的阿奇拉·被封印的欲望对应 `char067902`，技能展示默认循环 `loop_2`，另一展示动作循环 `loop`；两者使用不同的手工取景。图鉴中的这些动态展示与游戏内完整技能录像不同，不应把导出文件的 `cut_A`、`cut_B` 等片段自动拼成一场演出。

## Spine 运行时

`/vendor/spine/spine-player-4.1.56.js` 和 `.css` 直接下载自参考站仓库 `vendor/` 目录，保持原始字节：

- <https://raw.githubusercontent.com/clam314/bd2web/main/vendor/spine-player-4.1.56.js>
- <https://raw.githubusercontent.com/clam314/bd2web/main/vendor/spine-player-4.1.56.css>

Spine 运行时由 Esoteric Software 提供，受 **Spine Runtimes License Agreement** 约束。官方 `4.1` 分支的许可证原文保存于 `/vendor/spine/LICENSE`：<https://github.com/EsotericSoftware/spine-runtimes/blob/4.1/LICENSE>。该许可证包含 Spine Editor 许可要求，使用时需遵守其条款。

参考站 README 原文保存于 `/vendor/spine/README.bd2web.md`，其中说明这是非官方学习展示项目，并要求不要公开传播游戏素材。

## 本地验证

- 使用上述下载的 4.1.56 运行时解析二进制骨架成功；骨架导出版本为 **4.1.11**。
- 本地后备骨架的实际动画为 `idle`（4 秒）和 `motion`（约 1.33 秒）；其他角色和技能应读取各自骨架中的实际动画列表，不能沿用此命名。
- Atlas 的 `pma` 标记为 `false`，使用透明画布及非预乘透明度。
- 已检查 PNG 签名、2048 × 512 尺寸及全部 PNG 块 CRC，已检查 Atlas 纹理引用齐全；下载文件均非 HTML 错误页。

SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `char000101.skel` | `1dc04499cffdbcc74107a0d4f6470876cd977cefdbc7fbf0b2b3ce925c409af9` |
| `char000101.atlas` | `54e609e5250f3b46f498ba41804f5ab9174ddce73d2a4a98e022fdc0692b7f1f` |
| `char000101.png` | `89c18cf3af6a65ade093efdd7c47d294875a6cc0b6cf5428d0a9005344d8ef4d` |
| `spine-player-4.1.56.js` | `28d83fdbae0af5965d568d9607e9e20710dcce8b984c0a24e9d2a1d0915938bc` |
| `spine-player-4.1.56.css` | `2ce8e4f63557164fa77205aa4469c74950cf834f1ac91c222d794e6e66ae7e0c` |

