from __future__ import annotations

import anthropic
import openai
from fastapi import APIRouter, HTTPException

from .. import ai, settings_store
from ..schemas import ActRequest, LocateRequest, SettingsIn

router = APIRouter(tags=["ai"])


def _wrap(fn, req):
    try:
        return fn(req)
    except ai.AIUnavailable as e:
        raise HTTPException(400, str(e))
    except (anthropic.AuthenticationError, openai.AuthenticationError):
        raise HTTPException(401, "The AI API key is invalid.")
    except (anthropic.RateLimitError, openai.RateLimitError):
        raise HTTPException(429, "AI rate limit hit, retry shortly.")
    except (anthropic.APIConnectionError, openai.APIConnectionError):
        raise HTTPException(503, "Could not reach the AI provider.")
    except (anthropic.APIStatusError, openai.APIStatusError) as e:
        raise HTTPException(502, f"AI provider error: {e.message}")


@router.post("/ai/act")
def ai_act(req: ActRequest):
    return _wrap(ai.act, req)


@router.post("/ai/locate")
def ai_locate(req: LocateRequest):
    return _wrap(ai.locate, req)


@router.get("/settings")
def get_settings():
    return settings_store.public()


@router.put("/settings")
def put_settings(body: SettingsIn):
    return settings_store.update(**body.model_dump(exclude_none=True))
