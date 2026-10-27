from __future__ import annotations

import os
import tempfile
from pathlib import Path

import yaml

DATA_DIR = Path(os.environ.get("CONSOLE_DATA_DIR", "/data"))
# metacubexd 会以 mihomo 的 DATA_DIR（/data/metacubexd）作为 home，
# 只有该目录下的路径才允许 PUT /configs 热加载，因此配置放在其子目录。
CONSOLE_DIR = DATA_DIR / "metacubexd" / "console"
MIHOMO_YAML = CONSOLE_DIR / "mihomo.yaml"

TEMPLATE = """\
mixed-port: {mixed_port}
allow-lan: false
mode: rule
log-level: info
external-controller: 0.0.0.0:{api_port}
secret: {secret}
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
"""


def ensure_dir() -> None:
    CONSOLE_DIR.mkdir(parents=True, exist_ok=True)


def normalize(text: str, secret: str, mixed_port: int = 7890, api_port: int = 9090) -> str:
    """校验 YAML，并只补齐缺失的关键字段，不覆盖用户已有配置。"""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"YAML 解析失败：{exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("配置必须是一个 YAML 映射（键值对）")
    if not data:
        raise ValueError("配置内容为空")

    data.setdefault("external-controller", f"0.0.0.0:{api_port}")
    data.setdefault("secret", secret)
    data.setdefault("mixed-port", mixed_port)
    data.setdefault("allow-lan", False)

    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False)


def save(text: str) -> None:
    ensure_dir()
    fd, tmp = tempfile.mkstemp(dir=CONSOLE_DIR, prefix=".mihomo-", suffix=".yaml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, MIHOMO_YAML)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load() -> str | None:
    if not MIHOMO_YAML.exists():
        return None
    return MIHOMO_YAML.read_text(encoding="utf-8")


def template(secret: str, mixed_port: int = 7890, api_port: int = 9090) -> str:
    return TEMPLATE.format(secret=secret, mixed_port=mixed_port, api_port=api_port)
