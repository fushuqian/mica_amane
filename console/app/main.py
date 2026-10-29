from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import re
import subprocess
import time
import secrets as pysecrets
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import parse_qs, quote

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import clients as c
from . import config_store as store
from . import updater

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

CONSOLE_USER = os.environ.get("CONSOLE_USER", "admin")
CONSOLE_PASSWORD = os.environ.get("CONSOLE_PASSWORD", "")

PUBLIC_PATHS = {"/healthz", "/api/setup/state", "/login", "/logout"}

SESSION_COOKIE = "mica_session"
SESSION_TTL = 7 * 24 * 3600


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


def _check_credentials(user: str, password: str, source: str) -> bool:
    if source == "file":
        return store.verify_credentials(user, password)
    return pysecrets.compare_digest(user, CONSOLE_USER) and pysecrets.compare_digest(
        password, CONSOLE_PASSWORD
    )


def _session_secret() -> bytes:
    """登录 cookie 的签名密钥，持久化在 data 目录，重启后仍有效。"""
    path = store.CONSOLE_DIR / "session.key"
    try:
        key = path.read_bytes()
        if len(key) >= 16:
            return key
    except FileNotFoundError:
        pass
    key = pysecrets.token_bytes(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(key)
        path.chmod(0o600)
    except OSError:
        pass
    return key


def _issue_session() -> str:
    expires = str(int(time.time()) + SESSION_TTL)
    sig = hmac.new(_session_secret(), expires.encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}"


def _session_valid(token: str) -> bool:
    expires, _, sig = (token or "").partition(".")
    if not expires.isdigit():
        return False
    expected = hmac.new(_session_secret(), expires.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected) and int(expires) > time.time()


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/static/"):
        return await call_next(request)

    source = _auth_source()
    if source == "none":
        # 首次安装：允许免密进入，由向导引导设置管理员账号
        return await call_next(request)

    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
            user, _, password = decoded.partition(":")
        except Exception:  # noqa: BLE001
            user, password = "", ""
        if _check_credentials(user, password, source):
            return await call_next(request)

    if _session_valid(request.cookies.get(SESSION_COOKIE, "")):
        return await call_next(request)

    if path.startswith("/api/"):
        return JSONResponse({"detail": "需要登录"}, status_code=401)

    # 页面请求直接带去登录页，避免内嵌浏览器弹不出 Basic 认证框
    target = path + (f"?{request.url.query}" if request.url.query else "")
    return RedirectResponse(f"/login?next={quote(target)}", status_code=303)


@app.middleware("http")
async def static_no_cache(request: Request, call_next):
    """静态文件每次都用 ETag 重新校验，避免镜像更新后浏览器仍用旧样式。"""
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/updates")
async def updates_page():
    return FileResponse(STATIC_DIR / "updates.html")


@app.get("/settings")
async def settings_page():
    return FileResponse(STATIC_DIR / "settings.html")


@app.get("/login")
async def login_page(request: Request):
    if _auth_source() == "none":
        return RedirectResponse("/", status_code=303)
    if _session_valid(request.cookies.get(SESSION_COOKIE, "")):
        return RedirectResponse("/", status_code=303)
    return FileResponse(STATIC_DIR / "login.html")


@app.post("/login")
async def login_submit(request: Request):
    source = _auth_source()
    if source == "none":
        return RedirectResponse("/", status_code=303)

    raw = (await request.body()).decode("utf-8", "replace")
    form = {key: value[0] for key, value in parse_qs(raw).items()}
    user = form.get("username", "")
    password = form.get("password", "")
    target = form.get("next") or "/"
    if not target.startswith("/") or target.startswith("//"):
        target = "/"

    if not _check_credentials(user, password, source):
        return RedirectResponse(f"/login?error=1&next={quote(target)}", status_code=303)

    resp = RedirectResponse(target, status_code=303)
    resp.set_cookie(
        SESSION_COOKIE,
        _issue_session(),
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        path="/",
    )
    return resp


@app.get("/logout")
async def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _json(resp: httpx.Response):
    try:
        return resp.json()
    except ValueError:
        return resp.text[:500]


def _public_links() -> dict[str, str]:
    # 端口优先级：配置页手动设置 > AMANE_PUBLIC_PORT（compose 传入）> 8000
    stored = str(store.load_settings().get("amane_port") or "").strip()
    port = stored or os.environ.get("AMANE_PUBLIC_PORT", "") or "8000"
    return {
        "amane": os.environ.get("PUBLIC_AMANE_URL", ""),
        "amane_port": port,
    }


class AmanePortBody(BaseModel):
    port: str = ""


@app.post("/api/settings/amane_port")
async def set_amane_port(body: AmanePortBody):
    port = body.port.strip()
    if port and (not port.isdigit() or not 1 <= int(port) <= 65535):
        raise HTTPException(400, "端口需为 1-65535 的整数，留空则回退到环境变量")
    store.save_settings({"amane_port": port})
    return {"ok": True, "links": _public_links()}


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


AVATAR_PATH = store.CONSOLE_DIR / "avatar"


def _image_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


@app.get("/api/avatar")
async def get_avatar():
    try:
        data = AVATAR_PATH.read_bytes()
    except FileNotFoundError:
        raise HTTPException(404, "还没有设置头像") from None
    return Response(
        content=data,
        media_type=_image_type(data) or "application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


class AvatarBody(BaseModel):
    data: str


@app.post("/api/avatar")
async def set_avatar(body: AvatarBody):
    matched = re.match(r"^data:image/[a-zA-Z0-9.+-]+;base64,(.+)$", body.data.strip(), re.S)
    if not matched:
        raise HTTPException(400, "图片数据格式不正确")
    try:
        data = base64.b64decode(matched.group(1), validate=True)
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "图片解码失败") from None
    if len(data) > 512 * 1024:
        raise HTTPException(400, "图片不能超过 512KB")
    if not _image_type(data):
        raise HTTPException(400, "只支持 PNG / JPEG / WEBP / GIF")
    AVATAR_PATH.write_bytes(data)
    try:
        AVATAR_PATH.chmod(0o644)
    except OSError:
        pass
    return {"ok": True}


class AccountBody(BaseModel):
    current_password: str = ""
    username: str = ""
    password: str = ""


@app.get("/api/settings/account")
async def get_account():
    creds = store.load_credentials() or {}
    return {"username": creds.get("username") or CONSOLE_USER}


@app.post("/api/settings/account")
async def set_account(body: AccountBody):
    source = _auth_source()
    if source == "none":
        raise HTTPException(400, "尚未启用登录，请先完成设置向导")

    stored_user = (store.load_credentials() or {}).get("username") or CONSOLE_USER
    if not _check_credentials(stored_user, body.current_password, source):
        raise HTTPException(400, "当前密码不正确")

    username = body.username.strip()
    password = body.password
    if len(username) < 2:
        raise HTTPException(400, "用户名至少 2 个字符")
    if password:
        if len(password) < 8:
            raise HTTPException(400, "新密码至少 8 位")
        if password == username:
            raise HTTPException(400, "密码不能与用户名相同")
    else:
        password = body.current_password

    store.save_credentials(username, password)
    store.mark_onboarded("file")
    return {"ok": True, "username": username}


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
