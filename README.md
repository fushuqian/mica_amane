# Mica Amane

把 **amane**（影库刮削）和 **mihomo**（代理内核）打包进一个 Docker 容器，外加一个统一的配置页。

- 一个镜像、三个进程（mihomo / amane / 配置页），容器内通过 `127.0.0.1` 互通
- 只暴露两个 Web 端口：配置页 `8088`、amane `8000`
- 代理端口 `7890` 与 Clash API `9090` 只在容器内，不对宿主机开放
- 首次启动免密进入 6 步配置向导，完成后启用登录保护
- 订阅、节点屏蔽、登录凭据、amane 数据库全部持久化在 `/data`，重启不丢

镜像地址：`kenzong/mica-amane:latest`（`linux/amd64`）

---

## 端口与目录

| 端口 | 服务 | 是否对外 |
|---|---|---|
| `8088` | 配置页 | 是 |
| `8000` | amane Web/API | 是 |
| `9090` | mihomo Clash API | 否，仅容器内 |
| `7890` | mihomo 混合代理 | 否，仅容器内 |

| 路径 | 内容 |
|---|---|
| `/data` | 必须挂载：配置、订阅、屏蔽名单、登录凭据、amane 数据库 |
| `/media` | 媒体目录，挂载给 amane 刮削 |

---

## 方式一：NAS / Compose（推荐）

适合飞牛 fnOS、群晖、威联通等带 Compose 图形界面的 NAS。

1. 在 Docker → Compose 里新建项目
2. 粘贴 [`compose.pull.yaml`](compose.pull.yaml) 的内容
3. 改两处：

```yaml
- /vol1/1000/media:/media           # 换成 NAS 真实媒体目录
- "9000:8000"                       # 端口被占用就换
```

4. 启动项目，打开 `http://NAS_IP:8088`

环境变量、端口、卷挂载都已经写在 Compose 里，不需要手工配。

> 国内 NAS 直连 Docker Hub 可能超时，先在 NAS 设置里配「镜像加速」或给 Docker 配代理。

---

## 方式二：一键脚本（Linux / WSL / Git Bash）

```bash
git clone https://github.com/fushuqian/mica_amane.git
cd mica_amane
chmod +x deploy.sh
./deploy.sh
```

脚本会自动完成：

1. 检查 Docker 与 Docker Compose
2. 生成 `.env`（Clash API 密钥由容器首次启动自动生成）
3. 创建 `data/` 与媒体目录，处理 UID 1000 权限
4. 检查 8000 / 8088 端口占用
5. 拉取镜像并启动
6. 轮询 `/healthz`，就绪后打印访问地址

可选参数：

```bash
./deploy.sh --proxy http://127.0.0.1:7890   # 给拉取/构建过程走代理
./deploy.sh --panel-port 9088 --amane-port 9000
./deploy.sh --media-dir /mnt/media
./deploy.sh --build                         # 本地源码构建，不拉镜像
```

---

## 方式三：源码构建

```bash
git clone https://github.com/fushuqian/mica_amane.git
cd mica_amane
cp .env.example .env        # 按需修改端口、媒体目录等
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

NAS 图形界面里要现场构建，用 [`compose.nas.yaml`](compose.nas.yaml)（环境变量内嵌，可直接粘贴）。

构建需要访问 `ghcr.io` 拉取 amane 官方镜像与 mihomo 二进制；构建阶段 apt 与 pip 已配阿里云镜像。

---

## 环境变量

| 变量 | 说明 | 必填 |
|---|---|---|
| `CLASH_SECRET` | 已取消，无需配置；容器首次启动自动生成密钥，存于 `/data/mihomo/clash_secret`（0600，界面不展示），每次启动同步进 `config.yaml` | — |
| `CONSOLE_USER` | 登录保护的用户名，默认 `admin` | 否 |
| `CONSOLE_PASSWORD` | 留空 = 首次免密进向导；设置后以环境变量为准 | 否 |
| `AMANE_TOKEN` | amane Token，留空由程序生成 | 否 |
| `AMANE_SAFE_DIRS` | amane 可访问的媒体目录，默认 `/media` | 是 |
| `AMANE_PUBLIC_PORT` | amane 对外端口，用于配置页「进入 amane」跳转，默认 8000；用 compose 时自动跟随 `AMANE_PORT` | 否 |
| `SUB_USER_AGENT` | 订阅下载 UA，默认 `mihomo.party/v2.0.4 (clash.meta)` | 否 |
| `BIND_ADDR` | 端口绑定地址，公网反代模式改 `127.0.0.1` | 否 |
| `AMANE_PORT` / `PANEL_PORT` | 宿主机端口，默认 `8000` / `8088` | 否 |
| `MEDIA_DIR` | 宿主机媒体目录，默认 `./media` | 否 |
| `UPDATE_PROXY` | 配置页检查/下载 GitHub 更新时走的代理，留空则先试容器内 `127.0.0.1:7890`、再直连 | 否 |
| `GITHUB_TOKEN` | 可选，提高 GitHub API 限额（60 次/小时 → 5000 次/小时） | 否 |

---

## 首次启动向导

打开配置页后自动进入 6 步：

1. 欢迎与安全提示（免密模式仅限内网）
2. 环境自检：登录保护、mihomo / amane 是否在线
3. 导入订阅
4. 开启 amane 出网代理
5. 查看/复制 amane Token 与入口
6. 设置管理员账号密码

设置密码后浏览器会要求重新登录。已有环境变量密码的部署可以选择「沿用当前密码完成」。

向导完成标记在 `/data/mihomo/onboarded.json`，删除它再刷新页面即可重新触发。顶栏「设置向导」也能随时重开。

---

## 配置页功能

- amane 与 mihomo 的运行状态
- 明暗双主题，顶栏圆形按钮切换，选择持久化
- amane 对外端口设置（与「进入 amane」跳转联动）
- amane 出网代理开关
- amane Token 展示与一键复制（默认打码，点「显示」查看）
- mihomo 服务开关：关闭即停止内核并同步关闭 amane 出网代理，重启后保持关闭
- mihomo 模式切换（规则 / 全局 / 直连）
- 当前节点切换、延迟测速、节点屏蔽
- 订阅导入（写入 `config.yaml` 并热加载，重启依然生效）
- 更新检查与一键更新：
  - **程序本体**：从 GitHub 仓库下载最新提交的 `console/` 源码，热替换到 `/data/app/console` 后自动重启配置页
  - **mihomo**：从 GitHub Release 下载最新 `mihomo-linux-amd64` 内核，装到 `/data/mihomo/bin` 并重启内核（镜像内置版本不动，可随时删掉覆盖版本回退）
  - **amane**：上游只提供 CLI 二进制和 Docker 镜像，服务端无法单独热更，需随镜像更新

> 本项目不再内置 metacubexd。实时连接列表、请求日志、规则命中需要看日志：
> `docker compose logs -f stack`。

---

## 数据与升级

`/data` 下的内容：

```
/data
├── amane/                 # amane 数据库、token、插件
├── app/console/           # 配置页热更新版本（存在时优先于镜像内置版本）
├── update/state.json      # 已安装的热更新版本记录
└── mihomo/
    ├── config.yaml        # 唯一配置，订阅写入这里
    ├── blocked_nodes.json # 节点屏蔽名单
    ├── credentials.json   # 登录凭据（PBKDF2 哈希，无明文）
    ├── onboarded.json     # 向导完成标记
    ├── service.json       # mihomo 期望运行状态（关闭开关后为 false）
    ├── bin/mihomo         # 配置页更新的内核（存在时优先于镜像内置版本）
    └── geoip.dat / GeoSite.dat / geoip.metadb
```

升级方式：

1. 配置页「更新」卡片（推荐）：程序本体与 mihomo 直接点「更新」，无需命令行
2. 整体升级（含 amane）：
```bash
docker compose pull
docker compose up -d
```

回退：删掉 `/data/app/console`（程序本体）或 `/data/mihomo/bin/mihomo`（内核）后重启容器，即回到镜像内置版本。

手动运行的容器：拉新镜像后删掉旧容器，用同样的挂载和参数重新运行即可，`/data` 里的数据不会动。

---

## 常见问题

**容器反复重启？**
先看 `docker logs` 的报错。历史版本曾要求必须提供 `CLASH_SECRET`；现在密钥自动生成，不再需要任何配置。

**拉取镜像超时？**
Docker Hub 在国内可能不可达。给 Docker 配代理，或在 NAS 上配置镜像加速。

**amane 打不开媒体文件？**
容器以 UID 1000 运行，媒体目录需要可读：

```bash
sudo chown -R 1000:1000 /path/to/data /path/to/media
```

**配置页打不开 / 一直 401？**
`CONSOLE_PASSWORD` 设了值就会启用登录保护；忘记密码可删除 `/data/mihomo/credentials.json`，重启后回到免密向导。

**订阅导入失败？**
部分机场按 User-Agent 放行，调整 `SUB_USER_AGENT`；部分订阅服务器慢速滴流，超过 30 秒会超时。

---

## 上游

- [amane](https://github.com/sqzw-x/amane)
- [mihomo](https://github.com/MetaCubeX/mihomo)
- mihomo 二进制取自 `ghcr.io/metacubex/metacubexd-server` 镜像
