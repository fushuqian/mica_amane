#!/bin/sh
set -eu

: "${CONTROL_TOKEN:?CONTROL_TOKEN 未设置，请参考 .env.example}"
: "${CLASH_SECRET:?CLASH_SECRET 未设置，请参考 .env.example}"
: "${CONSOLE_PASSWORD:?CONSOLE_PASSWORD 未设置，请参考 .env.example}"

mkdir -p /data/amane /data/metacubexd /data/metacubexd/console
chown -R appuser:appuser /data

# metacubexd-server / mihomo
export NODE_ENV=production
export PORT="${CONTROL_PORT:-8080}"
export UI_DIST=/opt/mcx-app/ui-dist
export MIHOMO_BIN=/usr/local/bin/mihomo
export DATA_DIR=/data/metacubexd
export CLASH_API_PORT="${CLASH_API_PORT:-9090}"
export MIXED_PORT="${MIXED_PORT:-7890}"
export HOME=/data

# amane
export AMANE_DATA_DIR=/data/amane
export AMANE_LOG_DIR=/data/amane/logs
export AMANE_SAFE_DIRS="${AMANE_SAFE_DIRS:-/media}"
export AMANE_SUPERVISED=1

# 配置页
export CONSOLE_DATA_DIR=/data
export CONSOLE_AMANE_URL=http://127.0.0.1:8000
export CONSOLE_MIHOMO_URL=http://127.0.0.1:9090
export CONSOLE_METACUBEXD_URL=http://127.0.0.1:8080
export CONSOLE_USER="${CONSOLE_USER:-admin}"

# 可选变量：为空时不要导出，避免被下游当成有效值
if [ -n "${DEFAULT_BACKEND_URL:-}" ]; then
    export DEFAULT_BACKEND_URL
fi
if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GITHUB_TOKEN
fi
if [ -n "${AMANE_TOKEN:-}" ]; then
    export AMANE_TOKEN
fi
if [ -n "${AMANE_IMAGE_TOKEN:-}" ]; then
    export AMANE_IMAGE_TOKEN
fi

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
