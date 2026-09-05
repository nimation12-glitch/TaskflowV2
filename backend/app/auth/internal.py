"""
Service-to-service trust boundary between Next.js (NextAuth) and this backend.

Architecture:
  Browser -> Next.js (NextAuth validates session, resolves active org/role)
          -> FastAPI backend, called server-side only, with a short-lived
             signed JWT (HS256, shared secret AUTH_SECRET) asserting
             { sub: user_id, org_id, role, exp }.

This backend NEVER trusts a bare user_id/org_id passed as a normal request
parameter for anything sensitive — it must come from a verified token.
The browser never talks to this backend directly for session-bound routes;
only the public OpenAI-compatible /v1 API (authenticated via API key) is
reachable from arbitrary clients.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status
from jose import JWTError, jwt

from app.config import get_settings
from app.models.org import Role

ALGORITHM = "HS256"


@dataclass
class RequestContext:
    user_id: uuid.UUID
    organization_id: uuid.UUID
    role: Role


def _decode(token: str) -> dict:
    settings = get_settings()
    if not settings.auth_secret:
        # This should be unreachable in production due to startup validation,
        # but we never want a missing secret to silently accept tokens.
        raise HTTPException(status_code=500, detail="Server auth is not configured")
    try:
        return jwt.decode(token, settings.auth_secret, algorithms=[ALGORITHM])
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token") from exc


def require_context(authorization: str | None = Header(default=None)) -> RequestContext:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1]
    claims = _decode(token)
    try:
        return RequestContext(
            user_id=uuid.UUID(claims["sub"]),
            organization_id=uuid.UUID(claims["org_id"]),
            role=Role(claims["role"]),
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token claims") from exc


def require_role(*allowed: Role):
    def _check(ctx: RequestContext = Depends(require_context)) -> RequestContext:
        if ctx.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
        return ctx

    return _check
