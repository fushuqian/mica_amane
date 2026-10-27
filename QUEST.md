# 需求记录

| 编号 | 描述 | 状态 | 优先级 | 时间 |
|---|---|---|---|---|
| Q-001 | 把 amane、mihomo、metacubexd 整合进同一个 Docker 容器，容器内通过 127.0.0.1 互通，`7890` 不对外暴露 | 已完成 | 高 | 2026-10-27 |
| Q-002 | 提供统一配置页：服务状态、入口跳转、amane Token/代理设置、mihomo 订阅与配置编辑、节点切换 | 已完成 | 高 | 2026-10-27 |
| Q-003 | 支持外网访问 metacubexd：默认 VPN/内网方案，可选 Caddy HTTPS 反代（`public` profile） | 可选功能已提供，未启用 | 中 | 2026-10-27 |

## 部署信息

- 入口端口：`8000`（amane）、`8080`（metacubexd）、`8088`（配置页）、`9090`（mihomo API，面板需要）
- 内部端口：`7890`（mixed 代理）
- 数据目录：`./data/{amane,metacubexd}`（配置页 YAML 在 `./data/metacubexd/console`）
- 媒体目录：`./media`（可通过 `MEDIA_DIR` 修改）
- 启动：`cp .env.example .env` 后填写密钥，`docker compose up -d --build`
- 公网：`docker compose --profile public up -d`（需配置 `BASE_DOMAIN` 等）
