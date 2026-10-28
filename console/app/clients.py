from __future__ import annotations

import asyncio
import http.client
import os
import socket
import xmlrpc.client
from pathlib import Path
from urllib.parse import quote

import httpx

AMANE_URL = os.environ.get("CONSOLE_AMANE_URL", "http://127.0.0.1:8000").rstrip("/")
MIHOMO_URL = os.environ.get("CONSOLE_MIHOMO_URL", "http://127.0.0.1:9090").rstrip("/")
CLASH_SECRET = os.environ.get("CLASH_SECRET", "")
DATA_DIR = Path(os.environ.get("CONSOLE_DATA_DIR", "/data"))
SUPERVISOR_SOCK = os.environ.get("CONSOLE_SUPERVISOR_SOCK", "/run/supervisor.sock")

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


async def patch_clash(path: str, payload: dict, timeout: float = 10.0) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.patch(f"{MIHOMO_URL}{path}", json=payload, headers=clash_headers())


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


# ---------------- supervisor 控制（启停 mihomo） ----------------


class SupervisorError(RuntimeError):
    """supervisor 控制接口不可用或调用失败。"""


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str):
        super().__init__("localhost", timeout=15)
        self._socket_path = socket_path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


class _UnixTransport(xmlrpc.client.Transport):
    def make_connection(self, host):
        return _UnixHTTPConnection(SUPERVISOR_SOCK)


def _supervisor_rpc() -> xmlrpc.client.ServerProxy:
    return xmlrpc.client.ServerProxy("http://localhost/RPC2", transport=_UnixTransport())


def supervisor_state(name: str) -> str:
    try:
        for info in _supervisor_rpc().supervisor.getAllProcessInfo():
            if info.get("name") == name:
                return str(info.get("statename") or "UNKNOWN")
    except (OSError, xmlrpc.client.Error) as exc:
        raise SupervisorError(f"无法连接 supervisor：{exc}") from exc
    raise SupervisorError(f"supervisor 中没有名为 {name} 的进程")


def supervisor_action(name: str, action: str) -> None:
    rpc = _supervisor_rpc().supervisor
    try:
        if action == "stop":
            rpc.stopProcess(name, True)
        else:
            rpc.startProcess(name, True)
    except xmlrpc.client.Fault as exc:
        raise SupervisorError(str(exc.faultString)) from exc
    except (OSError, xmlrpc.client.Error) as exc:
        raise SupervisorError(f"无法连接 supervisor：{exc}") from exc


async def service_state(name: str) -> str | None:
    """进程状态；控制通道不可用时返回 None。"""
    try:
        return await asyncio.to_thread(supervisor_state, name)
    except SupervisorError:
        return None


async def service_running(name: str) -> bool | None:
    state = await service_state(name)
    if state is None:
        return None
    return state not in {"STOPPED", "EXITED", "FATAL"}


async def service_control(name: str, action: str) -> None:
    await asyncio.to_thread(supervisor_action, name, action)

