# syntax=docker/dockerfile:1
# Amane + mihomo + metacubexd 单容器整合
# 三个上游项目均以官方镜像为构建输入，不做源码编译。

# metacubexd 一体化服务端：Nitro + agent + mihomo 内核
FROM ghcr.io/metacubex/metacubexd-server:latest AS mcx

# amane 运行目录（含 uv 虚拟环境与前端产物）
FROM ghcr.io/sqzw-x/amane:latest AS amane

# 与最终层同为 Debian 系，只取 Node 运行时
FROM node:22-bookworm-slim AS node

FROM python:3.14-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$f" ]; then sed -i 's|deb.debian.org|mirrors.aliyun.com|g' "$f"; fi; \
    done; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl tini tzdata supervisor \
        libgomp1 libstdc++6 postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# 固定运行用户；/data 与 /media 需由该用户读写
RUN groupadd -g 1000 appuser \
    && useradd -u 1000 -g 1000 -M -d /data -s /bin/bash appuser

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=mcx /usr/local/bin/mihomo /usr/local/bin/mihomo
COPY --from=mcx /app /opt/mcx-app
COPY --from=amane /app /app

# 配置页使用独立 venv，避免污染 amane 的依赖
COPY console/requirements.txt /opt/console/requirements.txt
RUN python -m venv /opt/console/.venv \
    && /opt/console/.venv/bin/pip install --no-cache-dir \
        -i https://mirrors.aliyun.com/pypi/simple/ \
        -r /opt/console/requirements.txt

COPY console /opt/console
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && mkdir -p /data \
    && chown -R appuser:appuser /data

ENV PATH="/app/.venv/bin:/opt/console/.venv/bin:${PATH}"

EXPOSE 8000 8080 8088 9090 7890

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8088/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
