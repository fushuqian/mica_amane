# syntax=docker/dockerfile:1
# Amane + mihomo 单容器整合
# 两个上游项目均以官方镜像为构建输入，不做源码编译。

# 只从 metacubexd-server 镜像取 mihomo 内核二进制
FROM ghcr.io/metacubex/metacubexd-server:latest AS mcx

# amane 运行目录（含 uv 虚拟环境与前端产物）
FROM ghcr.io/sqzw-x/amane:latest AS amane

# 离线可用的 geo 数据（mihomo 缺 MMDB 会直接退出）
FROM alpine:3 AS geo
ARG GEO_BASE="https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release"
RUN apk add --no-cache curl \
    && mkdir -p /geo \
    && curl -fsSL --retry 3 --retry-delay 2 "$GEO_BASE/geoip.dat" -o /geo/geoip.dat \
    && curl -fsSL --retry 3 --retry-delay 2 "$GEO_BASE/country.mmdb" -o /geo/geoip.metadb \
    && curl -fsSL --retry 3 --retry-delay 2 "$GEO_BASE/geosite.dat" -o /geo/GeoSite.dat

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

COPY --from=mcx /usr/local/bin/mihomo /usr/local/bin/mihomo
COPY --from=amane /app /app
COPY --from=geo /geo /opt/mihomo-geo

# 配置页使用独立 venv，避免污染 amane 的依赖
COPY console/requirements.txt /opt/console/requirements.txt
RUN python -m venv /opt/console/.venv \
    && /opt/console/.venv/bin/pip install --no-cache-dir \
        -i https://mirrors.aliyun.com/pypi/simple/ \
        -r /opt/console/requirements.txt

COPY console /opt/console
COPY docker/start-console.sh docker/start-mihomo.sh /usr/local/bin/
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /usr/local/bin/start-console.sh /usr/local/bin/start-mihomo.sh \
    && mkdir -p /data \
    && chown -R appuser:appuser /data /opt/console

ENV PATH="/app/.venv/bin:/opt/console/.venv/bin:${PATH}"

EXPOSE 8000 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8088/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
