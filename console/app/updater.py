"""从 GitHub 直接更新：配置页本体（源码热替换）与 mihomo 内核（二进制替换）。

amane 服务端没有独立发布物（上游只发 CLI 与 Docker 镜像），只能随镜像更新。
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import clients as c

PANEL_REPO = os.environ.get("CONSOLE_UPDATE_REPO", "fushuqian/mica_amane")
AMANE_REPO = "sqzw-x/amane"
MIHOMO_REPO = "metacubex/mihomo"

DATA_DIR = c.DATA_DIR
STATE_JSON = DATA_DIR / "update" / "state.json"
PANEL_DIR = DATA_DIR / "app" / "console"
MIHOMO_BIN = DATA_DIR / "mihomo" / "bin" / "mihomo"

PIP = "/opt/console/.venv/bin/pip"
PIP_INDEX = "https://mirrors.aliyun.com/pypi/simple/"
MAX_DOWNLOAD = 200 * 1024 * 1024

UA = "mica-amane/1.0 (+https://github.com/fushuqian/mica_amane)"


def _proxies() -> list[str | None]:
    """更新下载走 mihomo 本机端口，失败再直连。"""
    items: list[str | None] = []
    env_proxy = os.environ.get("UPDATE_PROXY", "").strip()
    if env_proxy:
        items.append(env_proxy)
    items.extend(["http://127.0.0.1:7890", None])
    return items


def load_state() -> dict:
    try:
        data = json.loads(STATE_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_state(state: dict) -> None:
    STATE_JSON.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_JSON.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STATE_JSON)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _headers() -> dict[str, str]:
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def _get_json(url: str) -> dict:
    errors: list[str] = []
    for proxy in _proxies():
        kwargs = {"proxy": proxy} if proxy else {}
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True, **kwargs) as client:
                resp = await client.get(url, headers=_headers())
                resp.raise_for_status()
                return resp.json()
        except Exception as exc:  # noqa: BLE001 - 汇总后统一报错
            errors.append(f"{'代理' if proxy else '直连'}: {exc}")
    raise RuntimeError("；".join(errors))


async def _download(url: str, timeout: float = 180.0) -> bytes:
    errors: list[str] = []
    for proxy in _proxies():
        kwargs = {"proxy": proxy} if proxy else {}
        try:
            buf = bytearray()
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, **kwargs) as client:
                async with client.stream("GET", url, headers=_headers()) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_bytes(64 * 1024):
                        buf.extend(chunk)
                        if len(buf) > MAX_DOWNLOAD:
                            raise RuntimeError("文件超过 200MB，已中止")
            return bytes(buf)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{'代理' if proxy else '直连'}: {exc}")
    raise RuntimeError("；".join(errors))


async def _release(repo: str) -> tuple[str, list[dict]]:
    data = await _get_json(f"https://api.github.com/repos/{repo}/releases/latest")
    return str(data.get("tag_name") or ""), list(data.get("assets") or [])


async def _head_commit(repo: str) -> tuple[str, str]:
    # 不写死分支名（main / master 都可能），取默认分支最新一次提交
    data = await _get_json(f"https://api.github.com/repos/{repo}/commits?per_page=1")
    if not isinstance(data, list) or not data:
        raise RuntimeError("仓库没有任何提交")
    head = data[0]
    sha = str(head.get("sha") or "")
    date = str((head.get("commit") or {}).get("committer", {}).get("date") or "")
    return sha, date


async def _amane_version() -> str | None:
    try:
        resp = await c.get_amane("/api/health", timeout=4.0)
        if resp.status_code == 200:
            return resp.json().get("version")
    except Exception:  # noqa: BLE001
        pass
    return None


async def _mihomo_version() -> str | None:
    try:
        resp = await c.get_clash("/version", timeout=4.0)
        if resp.status_code == 200:
            return resp.json().get("version")
    except Exception:  # noqa: BLE001
        pass
    return None


def _short(sha: str) -> str:
    return sha[:7] if sha else ""


async def check_updates() -> dict:
    """并行查三方最新版本；任一上游不可达时把错误信息带回前端。"""
    state = load_state()
    panel_task = asyncio.create_task(_head_commit(PANEL_REPO))
    mihomo_task = asyncio.create_task(_release(MIHOMO_REPO))
    amane_task = asyncio.create_task(_release(AMANE_REPO))
    amane_cur_task = asyncio.create_task(_amane_version())
    mihomo_cur_task = asyncio.create_task(_mihomo_version())

    result: dict[str, dict] = {}
    errors: list[str] = []

    try:
        sha, date = await panel_task
        installed = str(state.get("panel", {}).get("commit") or "")
        result["panel"] = {
            "current": _short(installed) or "内置",
            "latest": _short(sha),
            "latest_date": date,
            "has_update": bool(sha) and installed != sha,
            "mode": "binary",
        }
    except Exception as exc:  # noqa: BLE001
        errors.append(f"程序本体：{exc}")
        result["panel"] = {"current": "", "latest": "", "has_update": False, "mode": "binary"}

    try:
        tag, _assets = await mihomo_task
        current = await mihomo_cur_task or str(state.get("mihomo", {}).get("version") or "")
        result["mihomo"] = {
            "current": current or "未知",
            "latest": tag,
            "has_update": bool(tag) and current != tag,
            "mode": "binary",
        }
    except Exception as exc:  # noqa: BLE001
        errors.append(f"mihomo：{exc}")
        result["mihomo"] = {"current": await mihomo_cur_task or "未知", "latest": "", "has_update": False, "mode": "binary"}

    try:
        tag, _assets = await amane_task
        current = await amane_cur_task
        current_full = current or "未知"
        result["amane"] = {
            "current": f"v{current_full}" if current and not str(current).startswith("v") else current_full,
            "latest": tag,
            "has_update": bool(tag) and str(current_full).lstrip("v") != tag.lstrip("v"),
            "mode": "image",
        }
    except Exception as exc:  # noqa: BLE001
        errors.append(f"amane：{exc}")
        result["amane"] = {"current": "未知", "latest": "", "has_update": False, "mode": "image"}

    return {"components": result, "errors": errors, "checked_at": _now()}


async def apply_mihomo() -> dict:
    """下载官方最新 release 的内核二进制，替换 /data 下的覆盖版本并重启。"""
    tag, assets = await _release(MIHOMO_REPO)
    name = f"mihomo-linux-amd64-{tag}.gz"
    url = next((a.get("browser_download_url") for a in assets if a.get("name") == name), None)
    if not url:
        raise RuntimeError(f"未找到发布产物 {name}")

    raw = await _download(url)
    try:
        binary = gzip.decompress(raw)
    except OSError as exc:
        raise RuntimeError(f"解压失败：{exc}") from exc

    MIHOMO_BIN.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=MIHOMO_BIN.parent, prefix=".mihomo-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(binary)
        os.chmod(tmp, 0o755)
        version = await asyncio.to_thread(_probe_mihomo, tmp)
        os.replace(tmp, MIHOMO_BIN)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    state = load_state()
    state["mihomo"] = {"version": version or tag, "at": _now()}
    _save_state(state)

    restarted = False
    if await c.service_running("mihomo"):
        await c.service_control("mihomo", "restart")
        restarted = True

    return {"ok": True, "version": version or tag, "restarted": restarted}


def _probe_mihomo(path: str) -> str | None:
    try:
        out = subprocess.run(
            [path, "-v"], capture_output=True, text=True, timeout=10, check=False
        )
        text = (out.stdout or out.stderr or "").strip()
        for token in text.split():
            if token.startswith("v"):
                return token.rstrip(",")
    except Exception:  # noqa: BLE001
        return None
    return None


def _extract_console(raw: bytes, staging: Path) -> Path:
    """从仓库 tarball 里只取 console/ 目录，并校验关键文件存在。"""
    staging.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=staging, suffix=".tar.gz", delete=False) as fh:
        fh.write(raw)
        archive = fh.name
    try:
        with tarfile.open(archive, "r:gz") as tar:
            members = []
            for member in tar.getmembers():
                parts = member.name.split("/", 2)
                if len(parts) < 3 or parts[1] != "console":
                    continue
                member.name = parts[2]
                members.append(member)
            tar.extractall(staging, members=members, filter="data")
    finally:
        os.unlink(archive)

    if not (staging / "app" / "main.py").exists() or not (staging / "static" / "index.html").exists():
        raise RuntimeError("下载内容不完整，缺少 app/main.py 或 static/index.html")
    return staging


def _requirements_hash(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def _install_requirements(new_dir: Path) -> None:
    req = new_dir / "requirements.txt"
    if not req.exists():
        return
    out = subprocess.run(
        [PIP, "install", "--no-cache-dir", "-i", PIP_INDEX, "-r", str(req)],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    if out.returncode != 0:
        tail = (out.stderr or out.stdout or "").strip().splitlines()[-3:]
        raise RuntimeError("依赖安装失败：" + " / ".join(tail))


async def apply_panel() -> dict:
    """下载仓库最新提交的 console/ 源码，热替换到 /data/app/console 后重启自身。"""
    sha, _date = await _head_commit(PANEL_REPO)
    raw = await _download(f"https://github.com/{PANEL_REPO}/archive/{sha}.tar.gz")

    parent = PANEL_DIR.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(dir=parent, prefix=".console-"))
    backup = parent / "console.old"
    try:
        _extract_console(raw, staging)
        await asyncio.to_thread(_install_requirements, staging)

        if backup.exists():
            shutil.rmtree(backup)
        if PANEL_DIR.exists():
            PANEL_DIR.rename(backup)
        staging.rename(PANEL_DIR)
        (PANEL_DIR / ".ready").write_text(_now(), encoding="utf-8")
        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        if not PANEL_DIR.exists() and backup.exists():
            backup.rename(PANEL_DIR)
        raise

    state = load_state()
    state["panel"] = {"commit": sha, "at": _now()}
    _save_state(state)
    return {"ok": True, "commit": _short(sha)}
