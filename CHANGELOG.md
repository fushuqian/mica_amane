# 变更记录

## 2026-10-28

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
