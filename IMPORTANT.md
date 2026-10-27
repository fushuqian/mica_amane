# 关键配置（不记录明文密钥）

## 端口

| 端口 | 服务 | 是否对外 |
|---|---|---|
| 8000 | amane Web/API | 是 |
| 8088 | 配置页 console | 是 |
| 9090 | mihomo Clash API | 否，仅容器内（console 使用） |
| 7890 | mihomo mixed 代理 | 否，仅容器内 |
| 80/443 | 可选 Caddy 反代 | 仅 public profile |

## 环境变量

| 键 | 用途 | 必填 |
|---|---|---|
| `CLASH_SECRET` | mihomo API 密钥（console 与内核共用） | 是 |
| `CONSOLE_USER` / `CONSOLE_PASSWORD` | 配置页 Basic Auth | 是 |
| `AMANE_TOKEN` | amane API Token（也可留空由程序生成） | 建议 |
| `AMANE_SAFE_DIRS` | amane 允许访问的媒体目录 | 是 |
| `SUB_USER_AGENT` | 订阅下载 UA（部分机场按 UA 放行） | 否 |
| `BIND_ADDR` | 端口绑定地址（公网模式改 127.0.0.1） | 否 |
| `MEDIA_DIR` | 宿主机媒体目录 | 否 |
| `BASE_DOMAIN` / `PANEL_USER` / `PANEL_PASSWORD_HASH` | Caddy 公网反代 | 仅 public |
| `PUBLIC_AMANE_URL` | 配置页上 amane 跳转地址（公网模式必填） | 否 |

## 路径

- `/data/amane`：amane 数据（SQLite、token、resources、plugins）
- `/data/mihomo`：mihomo 工作目录，`-d` 指向这里
  - `config.yaml`：唯一配置，首页订阅写入此处，重启后仍生效
  - `blocked_nodes.json`：首页节点屏蔽名单
  - `geoip.dat` / `geoip.metadb` / `GeoSite.dat`：geo 数据
- `/data/metacubexd`：已废弃，仅保留旧数据（迁移时从中复制一次）
- `/media`：媒体目录（宿主机挂载，UID 1000 需可读写）

## 上游

- https://github.com/sqzw-x/amane
- https://github.com/MetaCubeX/mihomo
- mihomo 二进制取自 `ghcr.io/metacubex/metacubexd-server:latest`，不再运行 metacubexd
