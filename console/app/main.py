from __future__ import annotations

import base64
import os
import secrets as pysecrets
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import clients as c
from . import config_store as store

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

CONSOLE_USER = os.environ.get("CONSOLE_USER", "admin")
CONSOLE_PASSWORD = os.environ.get("CONSOLE_PASSWORD", "")

app = FastAPI(title="Mica Amane Console", docs_url=None, redoc_url=None)


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if request.url.path == "/healthz" or not CONSOLE_PASSWORD:
        return await call_next(request)

    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
            user, _, password = decoded.partition(":")
        except Exception:  # noqa: BLE001
            user, password = "", ""
        if pysecrets.compare_digest(user, CONSOLE_USER) and pysecrets.compare_digest(
            password, CONSOLE_PASSWORD
        ):
            return await call_next(request)

    return Response(
        status_code=401,
        content="需要登录",
        headers={"WWW-Authenticate": 'Basic realm="amane-stack"'},
    )


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _json(resp: httpx.Response):
    try:
        return resp.json()
    except ValueError:
        return resp.text[:500]


def _public_links() -> dict[str, str]:
    return {"amane": os.environ.get("PUBLIC_AMANE_URL", "")}


@app.get("/api/status")
async def status():
    services: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            resp = await client.get(f"{c.AMANE_URL}/api/health")
            services["amane"] = {"online": resp.status_code == 200, "detail": _json(resp)}
        except Exception as exc:  # noqa: BLE001
            services["amane"] = {"online": False, "detail": str(exc)}

        mihomo: dict = {"online": False}
        try:
            ver = await client.get(f"{c.MIHOMO_URL}/version", headers=c.clash_headers())
            mihomo = {"online": ver.status_code == 200, "version": _json(ver)}
            cfg = await client.get(f"{c.MIHOMO_URL}/configs", headers=c.clash_headers())
            if cfg.status_code == 200:
                data = cfg.json()
                mihomo.update(
                    {
                        "mode": data.get("mode"),
                        "mixed_port": data.get("mixed-port"),
                        "port": data.get("port"),
                        "socks_port": data.get("socks-port"),
                        "allow_lan": data.get("allow-lan"),
                    }
                )
        except Exception as exc:  # noqa: BLE001
            mihomo["detail"] = str(exc)
        services["mihomo"] = mihomo

    return {"services": services, "links": _public_links()}


@app.get("/api/amane/token")
async def amane_token():
    token = c.amane_token()
    return {"token": token, "source": "env" if os.environ.get("AMANE_TOKEN") else "file"}


@app.get("/api/amane/config")
async def amane_config():
    """读取 amane 配置，用于首页判断出网代理是否已开启。"""
    try:
        resp = await c.get_amane("/api/config")
    except httpx.HTTPError:
        return {"available": False, "proxy": None}
    if resp.status_code >= 400:
        return {"available": False, "proxy": None}
    data = _json(resp)
    network = data.get("network") if isinstance(data, dict) else None
    proxy = network.get("proxy") if isinstance(network, dict) else None
    return {"available": True, "proxy": proxy}


class ProxyBody(BaseModel):
    url: str | None = None
    enabled: bool | None = None


@app.post("/api/amane/proxy")
async def set_amane_proxy(body: ProxyBody):
    if body.enabled is False:
        target = None
    else:
        target = (body.url or c.PROXY_URL).strip()
        if not target:
            target = c.PROXY_URL

    try:
        resp = await c.patch_amane("/api/config", {"network": {"proxy": target}})
        if target is None and resp.status_code >= 400:
            # 部分版本不接受 null，退回空字符串表示不启用代理
            target = ""
            resp = await c.patch_amane("/api/config", {"network": {"proxy": target}})
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 amane：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _json(resp))
    return {"ok": True, "proxy": target, "config": _json(resp)}


@app.get("/api/mihomo/config")
async def mihomo_config():
    try:
        resp = await c.get_clash("/configs")
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 mihomo：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _json(resp))
    return _json(resp)


class ModeBody(BaseModel):
    mode: str


@app.post("/api/mihomo/mode")
async def mihomo_mode(body: ModeBody):
    mode = body.mode.strip().lower()
    if mode not in {"rule", "global", "direct"}:
        raise HTTPException(400, "mode 只能是 rule / global / direct")
    try:
        resp = await c.patch_clash("/configs", {"mode": mode})
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 mihomo：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _json(resp))
    return {"ok": True, "mode": mode}


@app.get("/api/mihomo/blocked")
async def mihomo_blocked():
    return {"blocked": store.load_blocked()}


class BlockedBody(BaseModel):
    name: str
    blocked: bool = True


@app.post("/api/mihomo/blocked")
async def mihomo_set_blocked(body: BlockedBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name 不能为空")
    names = store.load_blocked()
    if body.blocked:
        names.append(name)
    else:
        names = [item for item in names if item != name]
    return {"blocked": store.save_blocked(names)}


@app.get("/api/mihomo/proxies")
async def mihomo_proxies():
    try:
        resp = await c.get_clash("/proxies")
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 mihomo：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _json(resp))
    return _json(resp)


class SelectBody(BaseModel):
    group: str
    name: str


@app.post("/api/mihomo/select")
async def mihomo_select(body: SelectBody):
    try:
        resp = await c.put_clash(c.select_url(body.group), {"name": body.name})
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 mihomo：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _json(resp))
    return {"ok": True}


class DelayBody(BaseModel):
    name: str
    url: str = "https://www.gstatic.com/generate_204"
    timeout: int = 5000


@app.post("/api/mihomo/delay")
async def mihomo_delay(body: DelayBody):
    try:
        resp = await c.get_clash(c.delay_url(body.name, body.url, body.timeout), timeout=15.0)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 mihomo：{exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, _json(resp))
    return _json(resp)


@app.get("/api/mihomo/yaml")
async def get_yaml():
    content = store.load()
    if content is None:
        content = store.template(c.CLASH_SECRET)
        exists = False
    else:
        exists = True
    return {"content": content, "exists": exists, "path": str(store.MIHOMO_YAML)}


class YamlBody(BaseModel):
    content: str


@app.post("/api/mihomo/yaml")
async def save_yaml(body: YamlBody):
    try:
        normalized = store.normalize(body.content, c.CLASH_SECRET)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    store.save(normalized)

    try:
        resp = await c.apply_config_file(str(store.MIHOMO_YAML))
    except httpx.HTTPError as exc:
        raise HTTPException(
            502, f"配置已保存，但热加载失败（mihomo 不可达）：{exc}"
        ) from exc
    if resp.status_code >= 400:
        raise HTTPException(
            resp.status_code, f"配置已保存，但热加载被拒绝：{_json(resp)}"
        )
    return {"ok": True, "path": str(store.MIHOMO_YAML)}


class SubBody(BaseModel):
    url: str


@app.post("/api/mihomo/subscription")
async def import_subscription(body: SubBody):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "订阅地址必须以 http:// 或 https:// 开头")

    try:
        text = await c.fetch_subscription(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"订阅下载失败：{exc}") from exc

    try:
        normalized = store.normalize(text, c.CLASH_SECRET)
    except ValueError as exc:
        raise HTTPException(400, f"订阅内容无效：{exc}") from exc

    store.save(normalized)

    try:
        resp = await c.apply_config_file(str(store.MIHOMO_YAML))
    except httpx.HTTPError as exc:
        raise HTTPException(
            502, f"订阅已保存，但热加载失败（mihomo 不可达）：{exc}"
        ) from exc
    if resp.status_code >= 400:
        raise HTTPException(
            resp.status_code, f"订阅已保存，但热加载被拒绝：{_json(resp)}"
        )
    return {"ok": True, "path": str(store.MIHOMO_YAML)}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
