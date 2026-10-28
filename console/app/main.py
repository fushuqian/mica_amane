from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import secrets as pysecrets
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import clients as c
from . import config_store as store
from . import updater

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

CONSOLE_USER = os.environ.get("CONSOLE_USER", "admin")
CONSOLE_PASSWORD = os.environ.get("CONSOLE_PASSWORD", "")

PUBLIC_PATHS = {"/healthz", "/api/setup/state"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 容器重启后 mihomo 会被 supervisor 自动拉起，这里恢复上一次「已关闭」的选择
    if not store.service_enabled():
        try:
            await c.service_control("mihomo", "stop")
        except c.SupervisorError:
            pass
    yield


app = FastAPI(title="Mica Amane Console", docs_url=None, redoc_url=None, lifespan=lifespan)


def _auth_source() -> str:
    """凭据优先级：向导写入的文件 > 环境变量 > 无（首次免密）。"""
    if store.load_credentials():
        return "file"
    return "env" if CONSOLE_PASSWORD else "none"


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS:
        return await call_next(request)

    source = _auth_source()
    if source == "none":
        # 首次安装：允许免密进入，由向导引导设置管理员账号
        return await call_next(request)

    header = request.headers.get("authorization", "")
    ok = False
    if header.startswith("Basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
            user, _, password = decoded.partition(":")
        except Exception:  # noqa: BLE001
            user, password = "", ""
        if source == "file":
            ok = store.verify_credentials(user, password)
        else:
            ok = pysecrets.compare_digest(user, CONSOLE_USER) and pysecrets.compare_digest(
                password, CONSOLE_PASSWORD
            )

    if ok:
        return await call_next(request)

    return Response(
        status_code=401,
        content="需要登录",
        headers={"WWW-Authenticate": 'Basic realm="mica-amane"'},
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
    mihomo_running = await c.service_running("mihomo")
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            resp = await client.get(f"{c.AMANE_URL}/api/health")
            services["amane"] = {"online": resp.status_code == 200, "detail": _json(resp)}
        except Exception as exc:  # noqa: BLE001
            services["amane"] = {"online": False, "detail": str(exc)}

        mihomo: dict = {"online": False}
        if mihomo_running is False:
            # 内核已被主动停止，不再探测 9090，避免每次刷新都等超时
            mihomo["running"] = False
        else:
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
            mihomo["running"] = mihomo_running
        services["mihomo"] = mihomo

    return {"services": services, "links": _public_links()}


@app.get("/api/setup/state")
async def setup_state():
    creds = store.load_credentials()
    source = "file" if creds else ("env" if CONSOLE_PASSWORD else "none")
    secret = os.environ.get("CLASH_SECRET", "")
    username = None
    if source == "file":
        username = creds.get("username")
    elif source == "env":
        username = CONSOLE_USER
    return {
        "needs_onboarding": not store.onboarding_done(),
        "auth_source": source,
        "username": username,
        "clash_secret_default": (not secret) or ("change-me" in secret),
    }


class CredentialsBody(BaseModel):
    username: str
    password: str


@app.post("/api/setup/credentials")
async def setup_credentials(body: CredentialsBody):
    username = body.username.strip()
    password = body.password
    if len(username) < 2:
        raise HTTPException(400, "用户名至少 2 个字符")
    if len(password) < 8:
        raise HTTPException(400, "密码至少 8 位")
    if password == username:
        raise HTTPException(400, "密码不能与用户名相同")
    store.save_credentials(username, password)
    # 设置密码后立即启用鉴权，当前浏览器需重新登录
    store.mark_onboarded("file")
    return {"ok": True, "auth_source": "file"}


class CompleteBody(BaseModel):
    set_credentials: bool = False


@app.post("/api/setup/complete")
async def setup_complete(body: CompleteBody | None = None):
    source = _auth_source()
    if source == "none":
        raise HTTPException(400, "请先设置管理员账号密码")
    store.mark_onboarded(source)
    return {"ok": True, "auth_source": source}


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


async def _apply_amane_proxy(target: str | None) -> httpx.Response:
    """写 amane 出网代理；None / 空字符串表示关闭。"""
    resp = await c.patch_amane("/api/config", {"network": {"proxy": target}})
    if target is None and resp.status_code >= 400:
        # 部分版本不接受 null，退回空字符串表示不启用代理
        resp = await c.patch_amane("/api/config", {"network": {"proxy": ""}})
    return resp


@app.post("/api/amane/proxy")
async def set_amane_proxy(body: ProxyBody):
    if body.enabled is False:
        target = None
    else:
        target = (body.url or c.PROXY_URL).strip()
        if not target:
            target = c.PROXY_URL

    try:
        resp = await _apply_amane_proxy(target)
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


class ServiceBody(BaseModel):
    enabled: bool


@app.get("/api/mihomo/service")
async def mihomo_service():
    state = await c.service_state("mihomo")
    return {
        "available": state is not None,
        "state": state,
        "enabled": None if state is None else state not in {"STOPPED", "EXITED", "FATAL"},
    }


@app.post("/api/mihomo/service")
async def mihomo_set_service(body: ServiceBody):
    if not body.enabled:
        # 先摘掉 amane 的出网代理，避免它继续指向已停的 7890
        try:
            resp = await _apply_amane_proxy(None)
            proxy_cleared = resp.status_code < 400
        except httpx.HTTPError:
            proxy_cleared = False

        try:
            await c.service_control("mihomo", "stop")
        except c.SupervisorError as exc:
            raise HTTPException(503, f"停止 mihomo 失败：{exc}") from exc

        store.save_service_enabled(False)
        return {"ok": True, "enabled": False, "proxy_cleared": proxy_cleared}

    try:
        await c.service_control("mihomo", "start")
    except c.SupervisorError as exc:
        raise HTTPException(502, f"启动 mihomo 失败：{exc}") from exc

    store.save_service_enabled(True)
    return {"ok": True, "enabled": True}


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


async def _apply_mihomo_config() -> None:
    """热加载配置；mihomo 不可达时重启内核再试一次，仍失败抛出带原因的 502。"""
    last = ""
    for attempt in range(2):
        try:
            resp = await c.apply_config_file(str(store.MIHOMO_YAML))
            if resp.status_code < 400:
                return
            last = f"热加载被拒绝：{_json(resp)}"
        except httpx.HTTPError as exc:
            last = f"mihomo 不可达（{exc}）"
        if attempt == 1:
            break
        try:
            await c.service_control("mihomo", "restart")
        except c.SupervisorError as exc:
            raise HTTPException(
                502, f"配置已保存，但 mihomo 未运行且重启失败：{exc}"
            ) from exc
        for _ in range(20):
            await asyncio.sleep(0.5)
            try:
                await c.get_clash("/version", timeout=2.0)
                break
            except httpx.HTTPError:
                continue
    raise HTTPException(
        502, f"配置已保存，但{last}。请查看容器日志里 mihomo 的报错"
    )


@app.post("/api/mihomo/yaml")
async def save_yaml(body: YamlBody):
    try:
        normalized = store.normalize(body.content, c.CLASH_SECRET)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    store.save(normalized)
    await _apply_mihomo_config()
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
    await _apply_mihomo_config()
    return {"ok": True, "path": str(store.MIHOMO_YAML)}


@app.get("/api/updates")
async def updates_check():
    try:
        return await updater.check_updates()
    except RuntimeError as exc:
        raise HTTPException(502, f"检查更新失败：{exc}") from exc


class UpdateBody(BaseModel):
    target: str


@app.post("/api/updates/apply")
async def updates_apply(body: UpdateBody):
    target = body.target.strip().lower()
    if target == "mihomo":
        try:
            return await updater.apply_mihomo()
        except (RuntimeError, c.SupervisorError) as exc:
            raise HTTPException(502, f"更新 mihomo 失败：{exc}") from exc
    if target == "panel":
        try:
            result = await updater.apply_panel()
        except RuntimeError as exc:
            raise HTTPException(502, f"更新程序本体失败：{exc}") from exc
        _schedule_console_restart()
        return result
    if target == "amane":
        raise HTTPException(
            400, "amane 服务端只能随镜像更新：docker compose pull && docker compose up -d"
        )
    raise HTTPException(400, "target 只能是 panel / mihomo / amane")


def _schedule_console_restart() -> None:
    """用脱离的 supervisorctl 重启配置页：直接调 stopProcess 会连调用者一起被杀。"""
    subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            "sleep 1; /usr/bin/supervisorctl -c /etc/supervisor/supervisord.conf restart console",
        ],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
