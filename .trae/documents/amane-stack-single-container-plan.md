# Amane + Mihomo + MetaCubeXD 单容器整合方案

## 1. 目标与结论

把三个项目装进**同一个 Docker 容器**，容器内部通过 `127.0.0.1` 互通，宿主机只需映射必要的 Web 端口，**`7890`** **混合代理端口不对外暴露**。同时提供一个独立的「配置页」，用于统一查看状态、跳转三个服务、查看 amane Token、把 amane 出网代理指向 mihomo、管理 mihomo 配置与订阅、切换节点。

最终形态：**1 个镜像 + 1 个 compose 服务**，包含 4 个进程：

| 进程                    | 来源                                       | 监听                                              | 说明                       |
| --------------------- | ---------------------------------------- | ----------------------------------------------- | ------------------------ |
| mihomo 内核             | `ghcr.io/metacubex/metacubexd-server` 内置 | `127.0.0.1:7890`（混合代理）`0.0.0.0:9090`（Clash API） | 由 metacubexd agent 拉起并托管 |
| metacubexd 面板 + agent | 同上                                       | `0.0.0.0:8080`                                  | 官方一体化服务端（Nitro + UI）     |
| amane                 | `ghcr.io/sqzw-x/amane`                   | `0.0.0.0:8000`                                  | 影库刮削服务                   |
| 配置页 console           | 本项目新写（Python/FastAPI）                    | `0.0.0.0:8088`                                  | 统一状态 / 配置管理              |

宿主机映射：`8000`、`8080`、`8088`、`9090`；**不映射** **`7890`**。

关键决策与依据：

* 采用 `metacubexd-server` 一体化镜像（老板已确认），它负责 mihomo 内核生命周期、订阅/profile 管理，避免自己重造轮子。

* 单容器内 4 个进程用 `supervisor` 托管；mihomo 由 metacubexd agent 以子进程方式拉起，不单列 supervisor 程序。

* 最终镜像基于 **Debian**（`python:3.14-slim`），因为 amane 要求 Python >= 3.14，Alpine 官方源无法满足；从官方镜像多阶段 COPY 现成产物，**不 clone / 不编译**三个上游项目，构建快、维护成本低。

* 配置页用 Python/FastAPI（与 amane 同栈），前端为无构建的静态 HTML/JS。

* metacubexd 的官方说明明确「Nitro 不代理 Clash API，UI 直连 `9090` 且需要 WebSocket」，所以 `9090` 必须映射给宿主机浏览器；`7890` 仍然只在容器内。

### 外网访问结论

**能正常访问，但有两个硬条件**：

1. 浏览器必须同时能访问 `8080`（面板）和 `9090`（Clash API + WebSocket）；只开 8080 面板会转圈连不上内核。
2. 页面是 HTTPS 时，`9090` 也必须是 HTTPS；HTTPS 页面调用 `http://IP:9090` 会被浏览器按「混合内容」拦截。纯 HTTP 访问则没有这个问题。

**安全前提**：`CONTROL_TOKEN` 会被 metacubexd 注入到浏览器里，它**不是访问控制**。把 8080/9090 直接暴露公网必须外加一层鉴权（反代 Basic Auth / OAuth）或走 VPN，否则等于把代理控制面交出去。

推荐两种落地方式（方案里同时给出，默认只开内网/VPN）：

* **默认（最稳）**：不做公网端口映射，用 Tailscale / WireGuard 回家；浏览器直接开 `http://<内网或 Tailscale IP>:8080` 与 `:9090`，无混合内容问题。

* **公网 HTTPS（可选）**：compose 增加一个 `public` profile 的 Caddy 服务：`https://域名/` → 8080，`https://域名/clash/*` → 9090（Caddy 自动处理 WebSocket），同域名路径代理天然同源、无 CORS；面板加 Basic Auth。amane 用单独子域名 `amane.域名` → 8000（其 SPA 用绝对路径，不建议挂子路径），配置页用 `panel.域名` → 8088。

## 2. 现状分析（已确认的事实）

### amane

* 镜像 `ghcr.io/sqzw-x/amane:latest`，入口 `python -m amane.server`，`/app/.venv` 为 uv 虚拟环境，前端静态文件在 `/app/web/dist`。

* 端口 `8000`；数据目录 `/data`（SQLite、`token`、`resources/`、`plugins/`）；媒体目录需通过 `AMANE_SAFE_DIRS` 声明。

* 环境变量：`AMANE_DATA_DIR`、`AMANE_LOG_DIR`、`AMANE_TOKEN`（可显式指定）、`AMANE_IMAGE_TOKEN`、`AMANE_SAFE_DIRS`、`AMANE_SUPERVISED=1`（有外部监督者时必须为 1）。

* 应用配置是热配置，接口为 `PATCH /api/config`（顶层 section 两层层级 merge）；网络段为 `network.proxy`（示例 `http://127.0.0.1:7890`）。除 `/api/health`、`/api/agent-guide` 外都要 Bearer Token。

* 官方 Dockerfile 基础镜像为 `python:3.14-slim`，需 `libgomp1`、`postgresql-client`。

### metacubexd-server

* 镜像 `ghcr.io/metacubex/metacubexd-server:latest`，运行时为 `node:22-alpine`。

* 目录：`/app/server/index.mjs`（Nitro 服务端）、`/app/ui-dist`（面板静态文件）、`/usr/local/bin/mihomo`（对应架构内核）。

* 入口脚本读取 `CONTROL_PORT` 并映射到 `PORT`，执行 `node /app/server/index.mjs`；agent 会注入 `external-controller: 0.0.0.0:<port>` 与 `secret`，并在 `/data` 下保存 profiles / active.yaml / 缓存。

* 环境变量：`CONTROL_TOKEN`、`CLASH_SECRET`、`CONTROL_PORT=8080`、`CLASH_API_PORT=9090`、`MIXED_PORT=7890`、`DATA_DIR=/data`、`UI_DIST`、`MIHOMO_BIN`、`DEFAULT_BACKEND_URL`、`GITHUB_TOKEN`。

* 依赖为纯 JS（`h3` / `nitropack` / `yaml` / `tree-kill`），把 `/app` 搬到 Debian 的 Node 22 上运行是可行的。

* **不代理 Clash API**：面板需要浏览器直连 `9090`（含 WebSocket）。

### 构建输入

* 本目录当前为空（无 git 仓库、无任何文件）。

* 本机已具备 Docker 29.9、Docker Compose v5.6、Git 2.55。

* 上游镜像均为公开镜像，可直接作为 multi-stage 的 `FROM` 源。

## 3. 目标目录结构

```
d:\Trae\mica_amane\
├── Dockerfile                 # 多阶段构建：抽取三个官方镜像产物，落到 Debian 运行层
├── compose.yaml               # 单服务定义 + 端口/卷/健康检查
├── .env.example               # 必填密钥与可选项模板
├── .gitignore
├── docker/
│   ├── entrypoint.sh          # 建目录、修权限、启动 supervisord
│   ├── supervisord.conf       # metacubexd / amane / console 三个 program
│   └── Caddyfile              # 可选：公网 HTTPS 反代（public profile）
├── console/                   # 配置页（Python/FastAPI）
│   ├── requirements.txt
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # FastAPI + Basic Auth + 路由
│   │   ├── clients.py         # amane / mihomo 的 HTTP 客户端
│   │   └── config_store.py    # YAML 读写、字段补齐、落盘
│   └── static/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── RULES.md                   # 项目规则（按老板规则 4 自动创建）
├── QUEST.md                   # 需求记录
├── CHANGELOG.md               # 变更记录
├── MEMORIES.md                # 经验教训
└── IMPORTANT.md               # 端口/路径/密钥占位说明（不写真实密钥）
```

运行时数据（git 忽略）：

```
data/
├── amane/        # AMANE_DATA_DIR
├── metacubexd/   # metacubexd-server 的 profiles / active.yaml / 缓存
└── console/      # 订阅 YAML、配置页自己的状态文件
media/            # 默认媒体目录，可改成宿主机任意路径
```

## 4. 具体改动

### 4.1 `Dockerfile`

多阶段：

1. `FROM ghcr.io/metacubex/metacubexd-server:latest AS mcx`：只取 `/app`（Nitro + UI）和 `/usr/local/bin/mihomo`。
2. `FROM ghcr.io/sqzw-x/amane:latest AS amane`：取 `/app`（含 `.venv`、源码、`web/dist`）。
3. `FROM node:22-bookworm-slim AS node`：取 `/usr/local/bin/node`。
4. `FROM python:3.14-slim` 最终层：

   * `apt-get install`：`libgomp1 postgresql-client tini ca-certificates tzdata curl supervisor`。

   * COPY 上述三份产物到 `/opt/mcx-app`、`/usr/local/bin/mihomo`、`/app`、`/usr/local/bin/node`。

   * 创建 `appuser`（默认 UID/GID 1000），`/data` 归属该用户。

   * 为配置页建独立 venv：`python -m venv /opt/console/.venv` + `pip install -r console/requirements.txt`，避免污染 amane 的 venv。

   * `EXPOSE 8000 8080 8088 9090 7890`，`HEALTHCHECK` 打 `http://127.0.0.1:8088/healthz`。

   * `ENTRYPOINT ["/usr/bin/tini","--"]`，`CMD ["/entrypoint.sh"]`。

构建风险与兜底：Nitro 产物从 Alpine 搬到 Debian 运行。若实际启动因原生模块失败，退路是在 Dockerfile 中新增 `node:22-bookworm-slim` 构建阶段，从 metacubexd 源码（固定 tag）用 pnpm 现场构建；此退路不影响其他文件设计。

### 4.2 `docker/entrypoint.sh`

* `mkdir -p /data/amane /data/metacubexd /data/metacubexd/console`。

* `chown -R 1000:1000 /data`。

* 给未设置的 env 兜底默认值（避免 supervisor 的 `%(ENV_xxx)s` 报错）。

* `exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf`。

### 4.3 `docker/supervisord.conf`

三个 program，均以 `appuser` 运行：

| program      | command                                                                                         | 关键 env                                                                                                                                                                                                              | 启动顺序        |
| ------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `metacubexd` | `/usr/local/bin/node /opt/mcx-app/server/index.mjs`                                             | `PORT=8080`、`UI_DIST=/opt/mcx-app/ui-dist`、`MIHOMO_BIN=/usr/local/bin/mihomo`、`DATA_DIR=/data/metacubexd`、`CONTROL_TOKEN`、`CLASH_SECRET`、`CLASH_API_PORT=9090`、`MIXED_PORT=7890`、`DEFAULT_BACKEND_URL`、`HOME=/data` | priority 10 |
| `amane`      | `/app/.venv/bin/python -m amane.server`                                                         | `AMANE_DATA_DIR=/data/amane`、`AMANE_LOG_DIR=/data/amane/logs`、`AMANE_SAFE_DIRS`、`AMANE_SUPERVISED=1`、`AMANE_TOKEN`、`HOME=/data`                                                                                     | priority 20 |
| `console`    | `/opt/console/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8088 --app-dir /opt/console` | `AMANE_URL`、`AMANE_TOKEN`、`MIHOMO_URL`、`CLASH_SECRET`、`METACUBEXD_URL`、`CONSOLE_USER`、`CONSOLE_PASSWORD`、`DATA_DIR=/data`                                                                                           | priority 30 |

统一 `autorestart=true`、日志走 `/dev/stdout` 与 `/dev/stderr`、`stopasgroup=true`、`killasgroup=true`（保证 mihomo 子进程随 agent 一起退出）。

### 4.4 `compose.yaml`

```yaml
services:
  stack:
    build: .
    image: amane-stack:latest
    container_name: amane-stack
    restart: unless-stopped
    env_file: .env
    ports:
      - "${BIND_ADDR:-0.0.0.0}:8000:8000"   # amane
      - "${BIND_ADDR:-0.0.0.0}:8080:8080"   # metacubexd 面板/agent
      - "${BIND_ADDR:-0.0.0.0}:8088:8088"   # 配置页
      - "${BIND_ADDR:-0.0.0.0}:9090:9090"   # mihomo Clash API（浏览器直连，含 WS）
      # 7890 故意不映射：容器内 127.0.0.1 使用
    volumes:
      - ./data:/data
      - "${MEDIA_DIR:-./media}:/media"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8088/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

  # 可选：只在需要公网 HTTPS 时启用（docker compose --profile public up -d）
  caddy:
    image: caddy:2-alpine
    profiles: ["public"]
    restart: unless-stopped
    depends_on:
      stack:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    environment:
      BASE_DOMAIN: ${BASE_DOMAIN}
      PANEL_USER: ${PANEL_USER}
      PANEL_PASSWORD_HASH: ${PANEL_PASSWORD_HASH}
    volumes:
      - ./docker/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data: {}
  caddy_config: {}
```

公网模式下把 `BIND_ADDR` 设为 `127.0.0.1`，宿主机端口只回环可达，由 Caddy 对外提供 80/443。

**`docker/Caddyfile`**（路径代理保持同源，规避 CORS；Caddy 自动处理 WebSocket）：

```caddyfile
dex.{$BASE_DOMAIN} {
    basic_auth {
        {$PANEL_USER} {$PANEL_PASSWORD_HASH}
    }
    handle_path /clash/* {
        reverse_proxy stack:9090
    }
    reverse_proxy stack:8080
}

amane.{$BASE_DOMAIN} {
    basic_auth {
        {$PANEL_USER} {$PANEL_PASSWORD_HASH}
    }
    reverse_proxy stack:8000
}

panel.{$BASE_DOMAIN} {
    reverse_proxy stack:8088
}
```

配合在 `.env` 中设置 `DEFAULT_BACKEND_URL=https://dex.${BASE_DOMAIN}/clash`，这样首次打开面板不需要手动填后端地址；`panel` 子域由配置页自身 Basic Auth 保护，Caddy 侧不重复加。

### 4.5 `.env.example`

```
# 必填：两个不同的强随机值
CONTROL_TOKEN=change-me-control
CLASH_SECRET=change-me-clash
# 配置页登录（Basic Auth）
CONSOLE_USER=admin
CONSOLE_PASSWORD=change-me-console
# amane
AMANE_TOKEN=change-me-amane
AMANE_SAFE_DIRS=/media
# 映射
BIND_ADDR=0.0.0.0
MEDIA_DIR=./media
TZ=Asia/Shanghai

# 可选：公网 HTTPS（--profile public 时使用）
# BASE_DOMAIN=example.com
# PANEL_USER=admin
# PANEL_PASSWORD_HASH=$2a$14$...   # caddy hash-password 生成
# DEFAULT_BACKEND_URL=https://dex.example.com/clash

真实 `.env` 写入 `IMPORTANT.md` 时只记录键名与用途，不记录明文。

### 4.6 配置页 `console/`（FastAPI）

**鉴权**：HTTP Basic，用 `CONSOLE_USER` / `CONSOLE_PASSWORD`；仅 `/healthz` 免鉴权。上 LAN 时不会裸奔。

**接口**（全部服务端转发，浏览器不直接持有密钥）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 页面 |
| GET | `/healthz` | 存活检查 |
| GET | `/api/status` | 聚合：amane `/api/health`、metacubexd `/api/control/health`、mihomo `/version` + `/configs`；返回各服务在线状态与版本 |
| GET | `/api/amane/token` | 返回 `AMANE_TOKEN`（env 未设置则读 `/data/amane/token`） |
| POST | `/api/amane/proxy` | `PATCH http://127.0.0.1:8000/api/config`，body `{"network":{"proxy":"http://127.0.0.1:7890"}}` |
| GET | `/api/mihomo/config` | 透传 mihomo `GET /configs` |
| GET | `/api/mihomo/proxies` | 透传 `GET /proxies`，前端只展示 selector/urltest 组 |
| POST | `/api/mihomo/select` | 透传 `PUT /proxies/{group}` |
| POST | `/api/mihomo/delay` | 透传 `GET /proxies/{name}/delay?url=...&timeout=5000` |
| GET | `/api/mihomo/yaml` | 读 `/data/metacubexd/console/mihomo.yaml` |
| POST | `/api/mihomo/yaml` | 校验 YAML → 补齐 `external-controller`、`secret`、`mixed-port`、`allow-lan`（仅缺失时）→ 原子写盘 → `PUT /configs?force=true` `{"path":"/data/metacubexd/console/mihomo.yaml"}` 热加载 |
| POST | `/api/mihomo/subscription` | 服务端下载订阅 URL（可经 `socks5h://127.0.0.1:7890`；失败则直连回退）→ 同样校验/补齐/落盘/热加载 |

**前端**（`static/index.html` + `app.js`，无构建）：
- 顶部：三个服务状态灯 + 版本 + 快捷按钮。
- 标签页：
  1. **总览**：状态卡片、amane Token 展示/复制、一键设置 amane 代理、入口按钮（自动用 `location.hostname` 拼 `:8000` / `:8080`）。
  2. **Mihomo**：当前模式/端口、订阅 URL 导入、YAML 编辑框、代理组节点列表（延迟测试 + 切换）。
  3. **关于**：端口表、数据目录、上游项目链接。
- 所有写操作给出明确成功/失败提示；失败展示上游返回的 `detail`。

**依赖**：`fastapi`、`uvicorn[standard]`、`httpx[socks]`、`pyyaml`。

### 4.7 项目规则文件（老板规则 4）

实现时创建：
- `RULES.md`：本项目约束（单容器、不暴露 7890、上游保持官方镜像、密钥走 env）。
- `QUEST.md`：录入本需求（描述/状态/优先级/时间）。
- `CHANGELOG.md`：首条记录本方案落地内容。
- `MEMORIES.md`：记录「metacubexd 不代理 Clash API、需暴露 9090」「amane 需 Python 3.14、不能进 Alpine」「单容器内 amane 代理指向 127.0.0.1:7890」等。
- `IMPORTANT.md`：端口表、路径表、环境变量键名与用途（无明文密钥）。

## 5. 假设与决策

1. **不源码编译三个项目**，以其官方镜像为构建输入；上游升级只需重新 `docker build --pull`。
2. **单容器 4 进程**，用 supervisor 而不是 s6-overlay，减少依赖。
3. **固定 UID/GID 1000**（`appuser`）。若宿主机媒体目录属主不是 1000，需要老板自行 `chown` 或改构建参数；不在本期做动态 PUID/PGID。
4. **`9090` 必须映射**，否则浏览器里的 metacubexd 无法连接内核（官方设计如此）。首次打开 metacubexd 时如未自动识别，手动填 `http://<宿主机IP>:9090` + `CLASH_SECRET`；也可通过 `DEFAULT_BACKEND_URL` 预填。
5. **外网访问默认走 VPN/内网**，公网直连不默认开启；需要公网 HTTPS 时用 `--profile public` 起 Caddy，并把 `BIND_ADDR` 改成 `127.0.0.1`。只映射 8080 而漏掉 9090、或 HTTPS 页面连 HTTP 9090，都会导致面板不可用。
6. **配置页的 YAML 热加载是便捷通道**，不取代 metacubexd 的 profile 管理；若之后在 metacubexd 里切换 profile，以其为准。UI 中会提示这一点。
7. **不支持 TUN**：单容器 + 端口映射模式下 TUN 需要 `network_mode: host` 与 `NET_ADMIN`，本期不启用。
8. **Windows/NAS 文件监控**：amane 在 Docker Desktop/网络盘场景需要在应用设置里开「轮询模式」，文档中提示。
9. **GitHub 同步**：当前目录不是 git 仓库。实现完成后本地 `git init` 并提交；老板提供远端仓库地址后再 push（规则 5）。
10. 不新建 README 等额外文档，部署说明集中在 `.env.example` 注释、`QUEST.md` 与配置页「关于」标签。

## 6. 验证步骤

1. `docker compose config` 校验 compose 与 `.env` 插值。
2. `docker compose build` 成功；确认最终镜像包含 `/app/.venv/bin/python`、`/usr/local/bin/node`、`/usr/local/bin/mihomo`、`/opt/mcx-app/server/index.mjs`。
3. `docker compose up -d`，`docker compose ps` 为 healthy；`docker compose logs -f` 无反复重启。
4. 端口验证：
   - `curl http://127.0.0.1:8000/api/health` → 200
   - `curl http://127.0.0.1:8080/api/control/health` → 200
   - `curl -H "Authorization: Bearer $CLASH_SECRET" http://127.0.0.1:9090/version` → 版本
   - `curl -u admin:... http://127.0.0.1:8088/api/status` → 三项均 online
   - `docker port amane-stack` **不包含 7890**
5. 浏览器：
   - `:8088` 配置页能登录、状态正确、Token 可复制。
   - 点「设置 amane 代理」后，amane「设置 → 网络 → 代理」显示 `http://127.0.0.1:7890`。
   - `:8080` metacubexd 能连上 `9090`，节点/规则/日志可用。
   - `:8000` amane 正常登录（Token 与配置页一致）。
6. 订阅导入：用一份测试订阅 URL，确认 `/data/metacubexd/console/mihomo.yaml` 生成、mihomo `GET /proxies` 出现新节点。
7. 持久化：`docker compose restart` 后 amane Token、订阅配置、metacubexd 数据仍在。
8. 外网访问（按所选模式验证其一）：
   - VPN 模式：从外网经 Tailscale/WireGuard 打开 `http://<隧道IP>:8080`，面板能连上 `:9090`，节点/日志实时刷新。
   - 公网 HTTPS 模式：`curl -I https://dex.<域名>/`、`https://dex.<域名>/clash/version` 均通过；浏览器中面板的连接/日志（WebSocket）持续更新；`docker port` 显示 8080/9090 仅绑定 `127.0.0.1`，公网只暴露 Caddy 的 80/443。
9. 回归：确认 `.env` 缺失时 compose 直接报错（必填变量），避免裸跑默认口令。
```

