from __future__ import annotations

import hmac

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config, db
from .routers import ai_routes, data, flows, profiles, runs


def create_app() -> FastAPI:
    db.connect()
    app = FastAPI(title="AutoBrowser API", version="0.3.0")

    # The UI is served from app:// (packaged) or localhost:3000 (dev).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["app://autobrowser", "http://localhost:3000"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)
        token = request.headers.get("x-autobrowser-token") or request.query_params.get("token") or ""
        if not hmac.compare_digest(token, config.API_TOKEN):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    @app.get("/health")
    def health():
        return {"ok": True}

    for r in (profiles.router, flows.router, runs.router, ai_routes.router, data.router):
        app.include_router(r)
    return app


app = create_app()
