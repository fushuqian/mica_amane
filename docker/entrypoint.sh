#!/bin/sh
set -eu

mkdir -p /data/amane /data/mihomo /data/mihomo/bin /data/app /data/update

# Clash API 密钥：首次启动自动生成并落盘，之后每次启动复用；界面不展示
SECRET_FILE=/data/mihomo/clash_secret
if [ ! -s "$SECRET_FILE" ]; then
    python3 -c 'import secrets; print(secrets.token_hex(32))' > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
fi
CLASH_SECRET=$(cat "$SECRET_FILE")
export CLASH_SECRET

# 一次性从旧的 metacubexd 数据目录迁移配置、屏蔽名单与 geo 数据
if [ ! -f /data/mihomo/config.yaml ] && [ -f /data/metacubexd/console/mihomo.yaml ]; then
    cp /data/metacubexd/console/mihomo.yaml /data/mihomo/config.yaml
fi
if [ ! -f /data/mihomo/blocked_nodes.json ] && [ -f /data/metacubexd/console/blocked_nodes.json ]; then
    cp /data/metacubexd/console/blocked_nodes.json /data/mihomo/blocked_nodes.json
fi
for f in geoip.dat geoip.metadb GeoSite.dat; do
    if [ ! -f "/data/mihomo/$f" ] && [ -f "/data/metacubexd/$f" ]; then
        cp "/data/metacubexd/$f" "/data/mihomo/$f"
    fi
done

# 镜像内置 geo 数据兜底：无外网时 mihomo 无法下载 MMDB，会直接退出
for f in geoip.dat geoip.metadb GeoSite.dat; do
    if [ ! -f "/data/mihomo/$f" ] && [ -f "/opt/mihomo-geo/$f" ]; then
        cp "/opt/mihomo-geo/$f" "/data/mihomo/$f"
    fi
done

# 首次启动没有配置时生成最小可用配置，保证 mihomo 能起来
if [ ! -f /data/mihomo/config.yaml ]; then
    cat > /data/mihomo/config.yaml <<EOF
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 0.0.0.0:9090
secret: ${CLASH_SECRET}
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
EOF
fi

# 每次启动都把密钥同步进 config.yaml，保证内核与配置页用的始终是同一个值
python3 - "$CLASH_SECRET" <<'PY'
import re
import sys

path = "/data/mihomo/config.yaml"
line = f"secret: {sys.argv[1]}"
text = open(path, encoding="utf-8").read()
if re.search(r"(?m)^secret:", text):
    text = re.sub(r"(?m)^secret:.*$", line, text, count=1)
else:
    text = text.rstrip("\n") + "\n" + line + "\n"
open(path, "w", encoding="utf-8").write(text)
PY

chown -R appuser:appuser /data

# mihomo
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
export CONSOLE_USER="${CONSOLE_USER:-admin}"

# 可选变量：为空时不要导出，避免被下游当成有效值
if [ -n "${AMANE_TOKEN:-}" ]; then
    export AMANE_TOKEN
fi
if [ -n "${AMANE_IMAGE_TOKEN:-}" ]; then
    export AMANE_IMAGE_TOKEN
fi

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
