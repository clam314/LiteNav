# 角色资源来源

此目录只收录个人导航页使用的一套本地待机资源：**拉德尔（Lathel）· 草药猎人**，资源 ID `char000101`。未收录声音、技能演出或其他角色资源。

## 参考页面与索引

- 参考页面：<https://clam314.github.io/bd2web/characters.html>
- 页面源码：<https://github.com/clam314/bd2web/blob/main/characters.html>
- 角色索引：<https://github.com/clam314/bd2web/blob/main/data/roster.json>
- 选择依据：索引内角色 `0001` / `拉德尔` / `Lathel` 的 `草药猎人` 服装，使用其 `idle` 部分。

角色索引于 2026-11-16 取得。该索引的来源字段已更新为 `424622b8c4fd`；这里的三个素材文件仍固定使用参考页面源码中的 `bc29e143fcdd`，未使用浮动的最新资源地址。

## 游戏素材

来源仓库：<https://github.com/myssal/Brown-Dust-2-Asset>，固定提交 `bc29e143fcdd`。

原始文件：

- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/bc29e143fcdd/spine/char/char000101/char000101.skel>
- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/bc29e143fcdd/spine/char/char000101/char000101.atlas>
- <https://raw.githubusercontent.com/myssal/Brown-Dust-2-Asset/bc29e143fcdd/spine/char/char000101/char000101.png>

三个文件均保持下载时的原始字节。Atlas 引用同目录下唯一的 `char000101.png`（2048 × 512），没有额外纹理依赖。上游 README 原文保存于 `assets/README.upstream.md`；在所选提交的仓库根目录中未发现独立的素材许可证。资源来源于《棕色尘埃 2》，相关权利仍归原权利人所有；此收录没有赋予再发布或商业使用权。当前集成用途为用户授权的私人本地导航页，未发布站点。

## Spine 运行时

`/vendor/spine/spine-player-4.1.56.js` 和 `.css` 直接下载自参考站仓库 `vendor/` 目录，保持原始字节：

- <https://raw.githubusercontent.com/clam314/bd2web/main/vendor/spine-player-4.1.56.js>
- <https://raw.githubusercontent.com/clam314/bd2web/main/vendor/spine-player-4.1.56.css>

Spine 运行时由 Esoteric Software 提供，受 **Spine Runtimes License Agreement** 约束。官方 `4.1` 分支的许可证原文保存于 `/vendor/spine/LICENSE`：<https://github.com/EsotericSoftware/spine-runtimes/blob/4.1/LICENSE>。该许可证包含 Spine Editor 许可要求，使用时需遵守其条款。

参考站 README 原文保存于 `/vendor/spine/README.bd2web.md`，其中说明这是非官方学习展示项目，并要求不要公开传播游戏素材。

## 本地验证

- 使用上述下载的 4.1.56 运行时解析二进制骨架成功；骨架导出版本为 **4.1.11**。
- 实际动画为 `idle`（4 秒）和 `motion`（约 1.33 秒）；此集成只循环播放 `idle`。
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

