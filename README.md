# 归航

一个以 PC 为主的个人网址与服务导航页。暗色界面，可自然扩展的常用入口，三列独立分类，分类卡内双列网址。服务监控在独立页面，首页仅在连续异常时提醒。

右下角“角色设置”打开小菜单，可独立控制随机人物、展示立绘、展示技能和人物信息，也可以指定人物与服装、选择技能动作、换一位或暂停动画。随机开启时每次打开页面更换人物；关闭后保留当前人物与服装。每个技能动作独立展示，优先使用角色图鉴中配置的循环动作；立绘和技能同时开启时轮流展示，均关闭时恢复导航完整宽度并释放播放器。展示默认关闭，兼容原有角色开关；设置只保存在当前浏览器的 localStorage（guihang.companion.preferences），不写入后台或导出配置。角色在宽度至少 1280px 的窗口中展示，并遵循系统减少动态效果偏好。

点击“角色设置”只展开菜单。打开“展示立绘”或“展示技能”后人物才出现；菜单内的“关闭角色”可一次关闭两种展示，并保留人物与服装选择。

角色索引包含 89 位人物、209 套服装，立绘和技能按可用素材筛选。索引与播放器保存在本地；除拉德尔·草药猎人的本地后备立绘外，选中素材从固定版本的上游按需加载，新角色首次加载需要联网。加载失败时可重试或使用本地立绘。资源来源与运行时许可见 public/companion/NOTICE.md。

`gamekee-presets.json` 保存 178 套服装的展示配置，其中 17 套尊爵服装有独立的动作和取景。带有 `motion` 动作的立绘会在待机 5 秒后播放一次，再回到待机。部分技能把人物、道具或特效分开导出，菜单将同一镜头的这些部件作为一个动作播放。莉亚特里斯「女仆代号R」服装 97 的搅拌动作会将双手和碗一起纳入画面。

切换人物、立绘或技能时保留当前画面，新动画画好首帧后用约 0.4 秒淡化过渡；请求失败仍保留原画面，可在角色菜单重试。立绘和技能同时开启时会提前缓存另一种展示的素材；连续快速切换会取消过期请求，关闭展示后释放播放器。系统开启减少动态效果时直接替换画面。

## 本地启动

只需 Python 3.11 或更新版本，无需安装第三方依赖。

    python3 server.py

打开 <http://127.0.0.1:8765>。也可用 npm run dev，它只调用相同的 Python 启动命令，不需要 npm install。

自定义地址与数据目录：

    python3 server.py --host 0.0.0.0 --port 8765 --data-dir ./data

默认只监听本机。需要其他设备访问时，再改为 0.0.0.0；本版本用于个人可信网络，向公网开放前应在反向代理配置身份验证。

## 使用

- **添加网址**：粘贴地址，自动识别常见网站名称、图标和分类；其他网页会尝试读取标题。识别失败仍可手动保存。
- **常用**：网址和服务统一排列。分类目录保留完整网址，服务不重复出现在网址分类中。
- **PC 布局**：常用默认每行 6 项，按实际数量自动增加行；目录固定三栏，各栏独立向下延伸，每个分类内部两列链接。常用顺序与分类网址顺序独立保存。
- **整理**：可编辑、删除、拖动调整常用及分类内的网址顺序；在设置中调整分类所在列。
- **服务监控**：在“我的服务”配置地址并启用检测。首页只提醒确认的掉线，详细状态在服务页查看。
- **备份**：导出配置为 JSON；导入前会校验格式，异常数据不会覆盖当前配置。

仓库内的 `seed.json` 只提供通用公共网站，不包含个人书签、私网地址或预先开启的服务监控。首次启动后，在页面中添加自己的网址和服务即可。

无法可靠识别类别的新网址可直接保存到“未分类”，后续在整理模式中调整。网站 Logo 优先使用已缓存的官网 favicon，获取失败时使用本地品牌图标或标记。来源见 public/icons/web/manifest.json 和 public/icons/ATTRIBUTION.md；运行时显示默认图标不依赖外部图标服务。

导入、导出仅在设置页的“数据备份”中提供。需要重新抓取公开网站图标时，可运行 python3 scripts/cache_favicons.py seed.json；脚本跳过内网网址及服务。

## 数据与监控

首次启动从 seed.json 初始化 SQLite，后续修改保存在 data/guihang.sqlite3，不会修改种子文件。不同浏览器访问同一服务器会读到同一份配置；同时编辑时用版本号避免互相覆盖。

`seed.json` 是随代码发布的默认配置；`data/` 是当前部署的个人数据，两者分别管理。只要保留 SQLite 文件或 Docker 数据卷，更新代码、默认配置和镜像都不会覆盖已有配置。个人备份、导出文件和含私人入口的截图应存放在 `data/` 或仓库外；`data/` 已同时从 Git 和 Docker 构建上下文排除。

监控由后台定时执行，关闭网页也会继续。默认每 60 秒检测一次，连续 3 次失败才判定离线；恢复可达后异常计数清零。HTTP 401/403 代表服务可达但需要登录，不会直接判定掉线。未开启的监控不会生成假状态。检测设置范围：间隔 10–86400 秒，失败阈值 1–10 次，超时 1–30 秒。

这检测的是服务 HTTP 入口可用性，不是容器进程或应用内部业务健康。后端必须能够访问要监控的地址。Docker 内的 localhost 指容器自身；访问宿主服务请使用局域网 IP，Docker Desktop 也可使用 host.docker.internal。

## Docker

使用 GitHub Actions 构建的镜像：

    docker login ghcr.io --username YOUR_GITHUB_USERNAME
    docker compose pull
    docker compose up -d --no-build

仓库关联的镜像为 `ghcr.io/clam314/guihang:latest`，默认保持私有。登录时使用具有 `read:packages` 权限的 GitHub Personal Access Token（classic），在密码提示中输入，不要写入配置文件或提交到仓库。认证方式见 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

也可直接本地构建：

    GUIHANG_IMAGE=guihang:local docker compose up -d --build

默认访问 <http://localhost:8765>。数据保存在命名卷 guihang-data；更新镜像不会覆盖导航配置。

从本地 Python 部署迁移到 Docker 时，在原页面的设置中导出个人配置，再在容器页面导入；不要把个人配置写回 `seed.json`。升级已有容器时保留数据卷，不要使用 `docker compose down -v`。

### 自动构建

`.github/workflows/docker.yml` 在推送 `main`、推送 tag 或手动触发时执行测试并发布 `linux/amd64`、`linux/arm64` 镜像。`latest` 跟随 `main`，另有版本 tag 和 `sha-完整提交号`；Pull Request 仅验证构建，不发布镜像。发布后会启动容器验证 HTTP 接口、通用默认配置与非 root 用户。

Actions 使用仓库自动提供的 `GITHUB_TOKEN`，无需另建发布密钥。流水线只向发布任务授予 `packages:write`，不会将个人数据目录加入镜像。运行记录见 [GitHub Actions](https://github.com/clam314/guihang/actions/workflows/docker.yml)。

## 验证

    npm test

使用 Node.js 内置测试运行器验证角色设置、随机选择、纹理页解析和动画取景，再运行 Python 后端测试；无需安装 npm 依赖。也可仅运行后端测试：

    python3 -m unittest discover -s tests -v

覆盖 SQLite 持久化、版本冲突、非法导入、重复网址、连续失败与恢复、过期结果隔离、自动识别回退、静态路径限制和 API 状态。

独立运行角色菜单浏览器回归（仅测试需要 Playwright，应用运行无需安装）：

    python3 -m pip install -r tests/requirements-browser.txt
    python3 -m playwright install chromium
    python3 tests/companion_ui_browser.py

## 文件

- public/：前端静态文件与本地图标。
- server.py：HTTP API、SQLite 存储、网页识别与后台监控。
- seed.json：首次使用的示例导航。
- data/：运行数据，已忽略提交。
