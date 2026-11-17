# 轻航（LiteNav）

一个轻量、清爽的个人网址与服务导航页，面向 PC 日常使用。

## 功能

- 常用入口与分类目录，支持编辑和拖动排序。
- 粘贴网址添加，自动识别常见网站的名称、图标和分类。
- 独立的服务专区，支持掉线检测和页面提醒。
- 可选角色动画，展示设置只保存在当前浏览器。
- 在设置中导入、导出配置，方便备份和迁移。

## 启动

使用 Python 3.11 或更新版本，无需安装额外依赖：

```sh
python3 server.py
```

也可以使用 Docker：

```sh
docker compose up -d --build
```

打开 [http://localhost:8765](http://localhost:8765) 即可使用。

## 配置

仓库只包含通用默认配置。个人数据保存在 `data/` 或 Docker 数据卷中，不随代码提交；更新时保留数据目录或数据卷即可。

GitHub Actions 支持自动测试和构建 amd64、arm64 镜像，镜像地址随所在仓库自动生成。

开发验证见 [验证记录](docs/VERIFICATION.md)，角色资源说明见 [资源声明](public/companion/NOTICE.md)。
