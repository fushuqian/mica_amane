# 需求记录

| 编号 | 描述 | 状态 | 优先级 | 时间 |
|---|---|---|---|---|
| Q-001 | 把 amane、mihomo、metacubexd 整合进同一个 Docker 容器，容器内通过 127.0.0.1 互通，`7890` 不对外暴露 | 已完成 | 高 | 2026-10-27 |
| Q-002 | 提供统一配置页：服务状态、入口跳转、amane Token/代理设置、mihomo 订阅与配置编辑、节点切换 | 已完成 | 高 | 2026-10-27 |
| Q-003 | 支持外网访问 metacubexd：默认 VPN/内网方案，可选 Caddy HTTPS 反代（`public` profile） | 可选功能已提供，未启用 | 中 | 2026-10-27 |
| Q-004 | 首页改为三卡片（amane / mihomo / metacubexd），运行状态与基础设置合并进卡片；移除标签页；新增节点屏蔽 | 已完成（metacubexd 卡片后随 Q-005 移除） | 高 | 2026-10-28 |
| Q-005 | 移除 metacubexd，由 supervisor 直接托管 mihomo，配置持久化到 `/data/mihomo/config.yaml`，释放 8080/9090 端口 | 已完成 | 高 | 2026-10-28 |
| Q-006 | 首次登录配置向导：免密进入 → 环境自检 → 导入订阅 → 开启 amane 代理 → Token 与入口 → 设置管理员账号密码 | 已完成 | 高 | 2026-10-28 |
| Q-007 | 一键部署：`deploy.sh` 自动生成 `.env`、随机密钥、建目录、可选代理构建、启动并等待健康 | 已完成 | 高 | 2026-10-28 |
| Q-008 | mihomo 卡片加服务开关（关闭即停内核并同步关闭 amane 出网代理、状态跨重启保持）；amane 卡片直接显示 Token 并提供复制 | 已完成 | 高 | 2026-10-28 |
| Q-009 | 配置页更新功能：程序本体与 mihomo 从 GitHub 一键更新，amane 随镜像更新 | 已完成 | 高 | 2026-10-28 |
| Q-010 | 镜像自动发布：GitHub Actions 在推送 master 时构建 `linux/amd64` 并推送 `kenzong/mica-amane:latest` 与 commit tag | 已完成 | 中 | 2026-10-28 |
| Q-011 | 全新部署离线可启动：镜像内置 geoip/geosite 数据，entrypoint 缺文件时补齐；订阅保存时内核不可达自动重启重试 | 已完成 | 高 | 2026-10-28 |
| Q-012 | amane 跳转端口可配置：compose 用 `AMANE_PUBLIC_PORT`（随 `AMANE_PORT`），配置页卡片内可手动填写并持久化到 `settings.json` | 已完成 | 高 | 2026-10-28 |
| Q-013 | 镜像每周定时构建，跟随上游 amane 最新版本 | 已完成 | 中 | 2026-10-28 |
| Q-014 | 配置页改用 Mica UI 设计语言，支持明暗双主题与本地持久化 | 已完成 | 中 | 2026-10-28 |
| Q-015 | 按 MICA-UI.md 规范重写界面：Hero + `mh-grid` 三列卡片 + `.mh-card__head/desc/foot` 结构 + `.mh-table` 更新表 + `.is-*` 状态类 | 已完成 | 中 | 2026-10-29 |
| Q-016 | 取消手工配置 `CLASH_SECRET`：容器首次启动自动生成随机密钥存 `/data/mihomo/clash_secret`（0600、界面不展示），每次启动同步进 `config.yaml`；订阅内自带的 secret 一律被覆盖 | 已完成 | 高 | 2026-10-29 |

## 部署信息

- 入口端口：配置页 `8088`、amane `AMANE_PORT`（默认 8000，配置页卡片可单独设置对外端口）
- 内部端口：`7890`（mixed 代理）、`9090`（Clash API，仅容器内）、`8000`（amane 内部监听）
- 数据目录：`./data/amane`、`./data/mihomo`、`./data/app`（配置页热更新）、`./data/update`（下载缓存）
- 媒体目录：`./media`（可通过 `MEDIA_DIR` 修改）
- 启动：`docker compose pull && docker compose up -d`（拉取已发布镜像）；本地源码构建用 `compose.yaml` + `compose.build.yaml` 或 `deploy.sh --build`
- 公网：`docker compose --profile public up -d`（需配置 `BASE_DOMAIN` 等）
