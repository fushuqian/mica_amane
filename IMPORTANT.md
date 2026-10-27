# 关键配置（不记录明文密钥）

## 端口

| 端口 | 服务 | 是否对外 |
|---|---|---|
| 8000 | amane Web/API | 是 |
| 8080 | metacubexd 面板 + agent | 是 |
| 8088 | 配置页 console | 是 |
| 9090 | mihomo Clash API（含 WS） | 是（面板必需） |
| 7890 | mihomo mixed 代理 | 否，仅容器内 |
| 80/443 | 可选 Caddy 反代 | 仅 public profile |

## 环境变量

| 键 | 用途 | 必填 |
|---|---|---|
| `CONTROL_TOKEN` | metacubexd agent 控制口令（注入浏览器，非访问控制） | 是 |
| `CLASH_SECRET` | mihomo API 密钥 | 是 |
| `CONSOLE_USER` / `CONSOLE_PASSWORD` | 配置页 Basic Auth | 是 |
| `AMANE_TOKEN` | amane API Token（也可留空由程序生成） | 建议 |
| `AMANE_SAFE_DIRS` | amane 允许访问的媒体目录 | 是 |
| `BIND_ADDR` | 端口绑定地址（公网模式改 127.0.0.1） | 否 |
| `MEDIA_DIR` | 宿主机媒体目录 | 否 |
| `BASE_DOMAIN` / `PANEL_USER` / `PANEL_PASSWORD_HASH` | Caddy 公网反代 | 仅 public |
| `DEFAULT_BACKEND_URL` | metacubexd 预填内核地址 | 公网建议 |

## 路径

- `/data/amane`：amane 数据（SQLite、token、resources、plugins）
- `/data/metacubexd`：metacubexd profiles / active.yaml / 缓存
- `/data/metacubexd/console`：配置页订阅 YAML
- `/media`：媒体目录（宿主机挂载，UID 1000 需可读写）

## 上游

- https://github.com/sqzw-x/amane
- https://github.com/MetaCubeX/mihomo
- https://github.com/MetaCubeX/metacubexd
