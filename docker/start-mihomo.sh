#!/bin/sh
# mihomo 入口：优先用 /data 下由配置页更新下载的版本，否则用镜像内置版本
set -eu

BIN=/usr/local/bin/mihomo
if [ -x /data/mihomo/bin/mihomo ]; then
    BIN=/data/mihomo/bin/mihomo
fi

exec "$BIN" -d /data/mihomo -f /data/mihomo/config.yaml
