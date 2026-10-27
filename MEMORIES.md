# 经验记录

- metacubexd 的 Nitro 服务端**不代理 Clash API**（WebSocket 无法经 Nitro 代理），面板由浏览器直连 `9090`，因此该端口必须对浏览器可达；HTTPS 页面不能连 HTTP 的 9090（混合内容）。
- metacubexd 的 `CONTROL_TOKEN` 会注入浏览器，只用于同源控制，不是访问控制；外网必须另加鉴权。
- amane 要求 Python >= 3.14，官方镜像基于 `python:3.14-slim`；无法直接放进 Alpine 的 metacubexd-server 镜像，故最终运行层选 Debian，再用多阶段 COPY 把两个官方镜像的产物拼起来。
- 单容器内 amane 的 `network.proxy` 设为 `http://127.0.0.1:7890`（mihomo 混合端口同时支持 HTTP/SOCKS），无需对外暴露。
- supervisor 的子进程会继承 supervisord 自身的环境变量，因此统一在 entrypoint 里 export，避免 `environment=` 里逗号分隔值（如 `AMANE_SAFE_DIRS=/media,/media2`）被错误解析。
- `metacubexd-server` 的 agent 会向活动配置注入 `external-controller` 与 `secret`，配置页热加载 YAML 时只补齐缺失字段，不覆盖已有值。
- mihomo 的 `PUT /configs` 有路径白名单：只允许其 home（本例为 `/data/metacubexd`）下的文件，否则报 `path is not subpath of home directory or SAFE_PATHS`。配置页 YAML 因此放在 `/data/metacubexd/console/`。
- 通过 `PUT /configs` 热加载的配置只在当前进程生效；容器重启后 metacubexd agent 会恢复自己的 active.yaml。需要长期生效请用 metacubexd 的 profile 管理。
- 国内构建：`deb.debian.org` 可能超时/404，Dockerfile 里把 apt 源换成 `mirrors.aliyun.com`，pip 用阿里云 PyPI 镜像。
- 部分机场按 User-Agent 放行：默认 UA 与 `clash-verge` 会被拦截/掐断，本机机场要求 `mihomo.party/v2.0.4 (clash.meta)`；已做成 `SUB_USER_AGENT` 环境变量。
- 订阅服务器可能“慢速滴流 + 不关闭连接”：30 秒只传 12–20KB，httpx 直接超时。后续需改为流式读取并在超时后使用已收到内容。
- mihomo 的 `geoip.metadb` / `GeoSite.dat` 自动下载可能被截断，导致内核启动报 `MMDB invalid` / `GeoSite.dat invalid`。用 jsdelivr 的 `meta-rules-dat@release` 手动替换 `/data/metacubexd/` 下文件即可恢复。
