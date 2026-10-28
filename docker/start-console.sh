#!/bin/sh
# 配置页入口：若 /data/app/console 有热更新版本则优先使用，否则回退镜像内置版本
set -eu

APP_DIR=/opt/console
if [ -f /data/app/console/.ready ] && [ -f /data/app/console/app/main.py ]; then
    APP_DIR=/data/app/console
fi

cd "$APP_DIR"
exec /opt/console/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8088 --app-dir "$APP_DIR"
