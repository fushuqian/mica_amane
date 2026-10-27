# 变更记录

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
