# 变更记录

## 2026-10-28

### 更新功能

- 配置页新增「更新」卡片：检查 GitHub 最新版本，程序本体与 mihomo 可一键更新；amane 显示「随镜像更新」。
- 程序本体走源码热更新：下载本仓库最新提交的 `console/` 到 `/data/app/console`，装齐依赖后写 `.ready` 标记并自动重启配置页（前端轮询 `/healthz` 后刷新）；失败自动回滚到旧目录。
- mihomo 走二进制替换：下载官方 release 的 `mihomo-linux-amd64-<tag>.gz`，解压校验版本后写入 `/data/mihomo/bin/mihomo`，重启内核生效；镜像内置二进制不动，删掉覆盖文件即回退。
- supervisor 配置改为启动脚本（`start-console.sh` / `start-mihomo.sh`），优先使用 `/data` 下的更新版本，否则回退镜像内置版本；`/opt/console` 与 venv 归 appuser，便于安装新依赖。
- 新增接口：`GET /api/updates`、`POST /api/updates/apply`（`panel` / `mihomo` / `amane`）。
- GitHub 访问支持代理：先试 `UPDATE_PROXY`，再试容器内 `127.0.0.1:7890`，最后直连；可选 `GITHUB_TOKEN` 提高 API 限额。
- 修复：热更新完成后配置页没能被拉起来（重启请求把自身进程杀掉，后续启动调用发不出去），改为脱离进程执行 `supervisorctl restart console`；顺带补上 `[supervisorctl]` 段与重复代理去重。
- 新增 GitHub Actions 工作流 `.github/workflows/publish.yml`：推送 `master` 时自动构建 `linux/amd64` 镜像并发布到 `kenzong/mica-amane:latest` 与 commit 标签（本机直推 Docker Hub 大层易超时，改由 CI 发布）。
- 部署改为 compose 拉取已发布镜像：`compose.yaml` 默认 `image: kenzong/mica-amane:latest`，源码构建用 `compose.yaml + compose.build.yaml` 覆盖；`deploy.sh` 默认 `docker compose pull && up -d`，需要本地构建加 `--build`。
- `publish.yml` 增加每周一 03:00 UTC 定时构建，用于跟随上游 amane 镜像更新。
- 修复：配置页「进入 amane」原先硬编码跳 `:8000`，宿主端口不同时打不开。改为按 `AMANE_PUBLIC_PORT`（compose 自动取自 `AMANE_PORT`）生成跳转地址与端口标签；公网反代仍可用 `PUBLIC_AMANE_URL` 覆盖。
- 配置页 amane 卡片新增「对外端口」输入框，手动填写后写入 `/data/mihomo/settings.json`，跳转地址与端口显示立即生效；优先级：手动设置 > `AMANE_PUBLIC_PORT` > 8000。
- 修复：全新部署且宿主机无外网时 mihomo 启动即 FATAL（`can't download MMDB`，遇到 `GEOIP` 规则直接退出）。镜像内置 `geoip.dat` / `geoip.metadb` / `GeoSite.dat`（构建时从 meta-rules-dat 下载），entrypoint 在数据目录缺文件时自动补齐。
- 修复：订阅导入/保存 YAML 时若 mihomo 不可达，自动重启内核后重试一次，并把真实原因回显到界面。
- 验证：容器内实测 mihomo v1.19.27 → v1.19.33（下载、解压、`-v` 校验、重启、`/api/status` 版本同步）；程序本体热更新后配置页 2 秒内自动恢复，`/api/updates` 显示当前提交与最新提交一致；`/api/updates` 正确比对三方版本并回报上游错误。

### mihomo 开关与 Token

- 首页 mihomo 卡片新增服务开关：关闭后停止 mihomo 内核，同时把 amane 出网代理清空；开启只恢复内核，不自动重新挂代理。
- 启停通过 supervisor XML-RPC 完成：supervisord 新增 `[unix_http_server]`（`/run/supervisor.sock`，chown appuser、chmod 0660）与 `[rpcinterface:supervisor]`；配置页以 appuser 身份调用，不需要额外权限。
- 关闭状态写入 `/data/mihomo/service.json`；容器重启后配置页启动时检测到「已关闭」会再次停掉被 supervisor 自动拉起的 mihomo。
- `/api/status` 新增 `services.mihomo.running`；内核被主动停止时不再探测 9090，避免每次刷新等 4 秒超时。前端在停止状态显示「已停止」，并禁用 amane 出网代理开关。
- amane 卡片新增 Token 区块：默认打码，可「显示 / 隐藏」，一键复制（非 HTTPS 环境自动回退 textarea 方案，避免 clipboard API 不可用）。
- 新增接口：`GET /api/mihomo/service`（返回 available/state/enabled）、`POST /api/mihomo/service`（`{"enabled": false}` 会先清代理再停内核）。
- 验证：真实容器内用 python:3.14-slim + supervisor 跑通 —— 关闭后 socket 进程 STOPPED、9090 端口关闭、假 amane 的 `network.proxy` 变为 null、`/api/status` 返回 `running:false`；重新开启后回到 RUNNING；`service.json` 正确写入。前端在 mock 页面验证开关、状态切换、Token 打码/显示/复制与折叠不误触，控制台无报错。

### 同日早前

- 首页卡片改为垂直排列：amane 在上、mihomo 在下；两张卡片标题栏可点击折叠/展开，状态记忆在浏览器 localStorage。
- Docker Hub 仓库说明已同步：短描述 + 完整 README（相对链接改为 GitHub 绝对地址）。
- 新增 `README.md`：项目说明、端口/目录、三种部署方式（NAS Compose / 一键脚本 / 源码构建）、环境变量表、首次向导、升级与常见问题。
- 镜像发布到 Docker Hub：`kenzong/mica-amane:latest`（linux/amd64，含 amane + mihomo + 配置页）。
- 新增 `compose.pull.yaml`：NAS 纯镜像版，不需要代码与构建，粘贴即可启动。
- 新增 `compose.nas.yaml`：NAS 图形界面（飞牛 fnOS / 群晖 / 威联通）可直接粘贴的 Compose，环境变量内嵌、端口与媒体路径可在界面里改。
- 新增 `deploy.sh` 一键部署：自动生成 `.env` 与随机 `CLASH_SECRET`、创建数据/媒体目录、端口占用检查、可选构建代理、启动并等待健康；支持 `--amane-port` / `--panel-port` / `--media-dir` / `--proxy` / `--no-build`。
- compose 端口改为可配置：`${AMANE_PORT:-8000}`、`${PANEL_PORT:-8088}`；`.env.example` 增加对应变量。
- 验证：脚本在 Git Bash 下以 `--no-build` 实跑通过，健康检查走 `/healthz`。
- 新增首次登录配置向导：环境自检 → 导入订阅 → amane 出网代理 → Token 与入口 → 设置管理员账号；完成后写 `/data/mihomo/onboarded.json`，顶栏「设置向导」可重开。
- 首次免密：`CONSOLE_PASSWORD` 留空时全站免鉴权，仅用于进入向导；向导设置密码后立即启用 Basic Auth。
- 登录凭据支持文件存储：`/data/mihomo/credentials.json` 只存 PBKDF2-SHA256 哈希（20 万次迭代、随机盐、权限 600），优先于环境变量密码。
- 新增接口：`GET /api/setup/state`（免鉴权）、`POST /api/setup/credentials`、`POST /api/setup/complete`。
- `entrypoint.sh` 不再强制要求 `CONSOLE_PASSWORD`；`.env.example` 改为可留空。
- 验证：全新安装免密进入 → 设置账号 → 旧会话 401、新凭据 200、重启后保持；已有环境密码的部署可「沿用当前密码完成」。
- **移除 metacubexd**：supervisor 直接托管 `mihomo -d /data/mihomo -f /data/mihomo/config.yaml`；Dockerfile 不再拉取 Node 与 `/opt/mcx-app`，镜像变小。
- 配置持久化：首页订阅直接写入 `/data/mihomo/config.yaml`，容器重启后仍生效（已实测：导入测试订阅→重启→节点保留）。
- 首次启动自动从旧的 `/data/metacubexd` 迁移配置、屏蔽名单与 geo 数据，旧目录保留未删。
- 端口收敛：不再映射 `8080`、`9090`，宿主只开 `8000`、`8088`。
- 首页去掉 metacubexd 卡片，改为 amane / mihomo 双卡片；`/api/status` 不再探测 metacubexd。
- `.env.example` 删除 `CONTROL_TOKEN`、`DEFAULT_BACKEND_URL`、`PUBLIC_METACUBEXD_URL`；Caddyfile 删除 `dex.*` 段。
- 配置页首页改版：去掉「总览 / Mihomo / 关于」标签页，改为卡片式布局，运行状态与基础设置同卡片展示。
- amane 卡片：出网代理改为开关，显示当前 proxy 值；后端 `POST /api/amane/proxy` 支持 `enabled` 开关，新增 `GET /api/amane/config` 读取当前值。
- mihomo 卡片：新增模式切换（rule/global/direct，`POST /api/mihomo/mode`）、当前节点选择与测速、订阅导入。
- 新增节点屏蔽：`GET/POST /api/mihomo/blocked`，名单存 `/data/mihomo/blocked_nodes.json`，被屏蔽节点从首页候选列表隐藏。
- 移除首页 YAML 编辑器与「关于」页。
- 验证：三服务状态、amane 代理读写、模式切换、屏蔽/恢复、订阅导入与重启持久化均通过。

## 2026-10-27

- 初始化项目结构：单容器整合 amane / mihomo / metacubexd。
- 新增 `Dockerfile`：多阶段抽取官方镜像产物，落到 Debian + Python 3.14 运行层。
- 新增 `docker/supervisord.conf`、`docker/entrypoint.sh`：托管 metacubexd、amane、配置页三个进程。
- 新增 `compose.yaml`、`.env.example`：端口映射（不含 7890）、卷、健康检查、可选 Caddy 反代。
- 新增配置页 `console/`：状态总览、amane Token/代理设置、mihomo 订阅/配置/节点管理。
- 新增 `docker/Caddyfile`：可选公网 HTTPS 路径反代（`public` profile）。
- 构建：apt 源改用阿里云镜像、pip 改用阿里云 PyPI，规避 `deb.debian.org` 超时。
- 修复：mihomo `PUT /configs` 只允许其 home（`/data/metacubexd`）下的路径，配置页 YAML 改存 `/data/metacubexd/console/mihomo.yaml`。
- 验证通过：容器 healthy；8000/8080/8088/9090 正常，7890 未映射；amane 代理设置、订阅导入与热加载、重启持久化均通过。
- 新增 `SUB_USER_AGENT`（默认 `mihomo.party/v2.0.4 (clash.meta)`），适配按 UA 放行的机场。
- 修复 mihomo 内核启动失败：`geoip.metadb` / `GeoSite.dat` 自动下载被截断，已用 jsdelivr 的有效数据替换。
- 配置页调整：amane 面板只保留「进入 amane」按钮；一键设置 amane 出网代理移到 Mihomo 页并改用 HTTP 协议（`http://127.0.0.1:7890`）。
