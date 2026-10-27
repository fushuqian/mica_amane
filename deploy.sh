#!/usr/bin/env bash
# Mica Amane 一键部署（Linux / NAS / WSL / Git Bash）
set -euo pipefail

PROXY=""
AMANE_PORT=""
PANEL_PORT=""
MEDIA_DIR=""
NO_BUILD=0

usage() {
  cat <<'EOF'
Mica Amane 一键部署

用法:
  ./deploy.sh [选项]

选项:
  --proxy URL        构建时使用的 HTTP 代理，如 http://127.0.0.1:7890
  --amane-port PORT  amane 面板的宿主机端口（默认 8000）
  --panel-port PORT  配置页的宿主机端口（默认 8088）
  --media-dir PATH   宿主机媒体目录（默认 ./media）
  --no-build         跳过构建，直接用已有的 amane-stack 镜像启动
  -h, --help         显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --amane-port) AMANE_PORT="${2:-}"; shift 2 ;;
    --panel-port) PANEL_PORT="${2:-}"; shift 2 ;;
    --media-dir) MEDIA_DIR="${2:-}"; shift 2 ;;
    --no-build) NO_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1"; usage; exit 1 ;;
  esac
done

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker，请先安装 Docker（https://docs.docker.com/engine/install/）"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker 未运行或当前用户无权限，请先启动 Docker 并把用户加入 docker 组"
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "未找到 docker compose，请安装 Docker Compose v2"
  exit 1
fi

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

set_env() {
  key="$1"
  val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

get_env() {
  grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

# ---------- .env ----------

if [ ! -f .env ]; then
  cp .env.example .env
  set_env CLASH_SECRET "$(gen_secret)"
  echo "已生成 .env，并随机化 CLASH_SECRET"
else
  echo "检测到已有 .env，沿用现有配置"
fi

[ -n "$AMANE_PORT" ] && set_env AMANE_PORT "$AMANE_PORT"
[ -n "$PANEL_PORT" ] && set_env PANEL_PORT "$PANEL_PORT"
[ -n "$MEDIA_DIR" ] && set_env MEDIA_DIR "$MEDIA_DIR"

AMANE_PORT_VAL="$(get_env AMANE_PORT)"
PANEL_PORT_VAL="$(get_env PANEL_PORT)"
MEDIA_PATH="$(get_env MEDIA_DIR)"
[ -n "$AMANE_PORT_VAL" ] || AMANE_PORT_VAL=8000
[ -n "$PANEL_PORT_VAL" ] || PANEL_PORT_VAL=8088
[ -n "$MEDIA_PATH" ] || MEDIA_PATH="./media"

if grep -q '^CLASH_SECRET=change-me' .env 2>/dev/null; then
  set_env CLASH_SECRET "$(gen_secret)"
  echo "检测到示例 CLASH_SECRET，已替换为随机值"
fi

# ---------- 目录与权限 ----------

mkdir -p data "$MEDIA_PATH"

if [ "$(id -u)" -eq 0 ]; then
  chown -R 1000:1000 data "$MEDIA_PATH" || true
else
  echo "提示：容器内以 UID 1000 运行；若媒体读写失败请执行 sudo chown -R 1000:1000 data $MEDIA_PATH"
fi

# ---------- 端口冲突 ----------

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "(^|:)$1$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "(^|:)$1$"
  else
    return 1
  fi
}

running="$($DC ps --status running -q 2>/dev/null | head -n 1 || true)"
if [ -z "$running" ]; then
  if port_busy "$AMANE_PORT_VAL"; then
    echo "宿主端口 $AMANE_PORT_VAL 已被占用，请用 --amane-port 指定其他端口"
    exit 1
  fi
  if port_busy "$PANEL_PORT_VAL"; then
    echo "宿主端口 $PANEL_PORT_VAL 已被占用，请用 --panel-port 指定其他端口"
    exit 1
  fi
fi

# ---------- 构建 ----------

if [ -n "$PROXY" ]; then
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" ALL_PROXY="$PROXY"
  echo "构建代理：$PROXY"
  echo "注意：Docker 拉取基础镜像走 daemon；若 FROM 拉取失败，请给 Docker daemon 配代理"
fi

if [ "$NO_BUILD" -eq 0 ]; then
  echo "开始构建镜像（首次较慢）…"
  if [ -n "$PROXY" ]; then
    $DC build --build-arg "HTTP_PROXY=$PROXY" --build-arg "HTTPS_PROXY=$PROXY"
  else
    $DC build
  fi
fi

echo "启动容器…"
$DC up -d

# ---------- 等待就绪 ----------

echo "等待服务就绪…"

check_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "http://127.0.0.1:${PANEL_PORT_VAL}/healthz" >/dev/null 2>&1
  else
    st="$(docker inspect --format '{{.State.Health.Status}}' amane-stack 2>/dev/null || true)"
    [ "$st" = "healthy" ]
  fi
}

healthy=0
i=0
while [ "$i" -lt 40 ]; do
  i=$((i + 1))
  if check_health; then
    healthy=1
    break
  fi
  sleep 3
done

if [ "$healthy" -eq 0 ]; then
  echo "服务未在预期时间内就绪，最近日志："
  $DC logs --tail 30 stack || true
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
if [ -z "$IP" ]; then
  IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)"
fi
[ -n "$IP" ] || IP="<主机IP>"

cat <<EOF

部署完成。

  配置页: http://${IP}:${PANEL_PORT_VAL}
  amane  : http://${IP}:${AMANE_PORT_VAL}

首次打开配置页会自动进入 6 步向导：设置管理员账号 → 环境自检 → 导入订阅 → 开启代理 → Token → 完成。

常用命令:
  $DC logs -f stack
  $DC restart
  $DC down

EOF
