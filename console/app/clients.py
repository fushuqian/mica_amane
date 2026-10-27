from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

import httpx

AMANE_URL = os.environ.get("CONSOLE_AMANE_URL", "http://127.0.0.1:8000").rstrip("/")
MIHOMO_URL = os.environ.get("CONSOLE_MIHOMO_URL", "http://127.0.0.1:9090").rstrip("/")
METACUBEXD_URL = os.environ.get("CONSOLE_METACUBEXD_URL", "http://127.0.0.1:8080").rstrip("/")
CLASH_SECRET = os.environ.get("CLASH_SECRET", "")
DATA_DIR = Path(os.environ.get("CONSOLE_DATA_DIR", "/data"))

PROXY_URL = "http://127.0.0.1:7890"
SUB_PROXY_URL = "socks5h://127.0.0.1:7890"
SUB_USER_AGENT = os.environ.get("SUB_USER_AGENT", "mihomo.party/v2.0.4 (clash.meta)")


def amane_token() -> str:
    token = os.environ.get("AMANE_TOKEN", "").strip()
    if token:
        return token
    path = DATA_DIR / "amane" / "token"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def amane_headers() -> dict[str, str]:
    token = amane_token()
    return {"Authorization": f"Bearer {token}"} if token else {}


def clash_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {CLASH_SECRET}"} if CLASH_SECRET else {}


async def get_amane(path: str, timeout: float = 5.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.get(f"{AMANE_URL}{path}", headers=amane_headers())


async def patch_amane(path: str, payload: dict, timeout: float = 10.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.patch(f"{AMANE_URL}{path}", json=payload, headers=amane_headers())


async def get_clash(path: str, timeout: float = 5.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.get(f"{MIHOMO_URL}{path}", headers=clash_headers())


async def put_clash(path: str, payload: dict, timeout: float = 10.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.put(f"{MIHOMO_URL}{path}", json=payload, headers=clash_headers())


async def apply_config_file(path: str, timeout: float = 30.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.put(
            f"{MIHOMO_URL}/configs?force=true",
            json={"path": path},
            headers=clash_headers(),
        )


async def fetch_subscription(url: str, timeout: float = 30.0) -> str:
    """优先经容器内代理下载订阅，失败后回退直连。"""
    errors: list[str] = []
    for proxy in (SUB_PROXY_URL, None):
        try:
            kwargs = {"proxy": proxy} if proxy else {}
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, **kwargs) as client:
                resp = await client.get(url, headers={"User-Agent": SUB_USER_AGENT})
                resp.raise_for_status()
                return resp.text
        except Exception as exc:  # noqa: BLE001 - 汇总后统一报错
            errors.append(f"{'代理' if proxy else '直连'}: {exc}")

    raise RuntimeError("；".join(errors))


def select_url(name: str) -> str:
    return f"/proxies/{quote(name, safe='')}"


def delay_url(name: str, test_url: str, timeout_ms: int) -> str:
    return (
        f"/proxies/{quote(name, safe='')}/delay"
        f"?url={quote(test_url, safe='')}&timeout={timeout_ms}"
    )
