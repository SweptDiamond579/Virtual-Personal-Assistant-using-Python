"""GitHub integration (REST v3).

Connection: a fine-grained Personal Access Token pasted in the Integrations
workspace, validated against `GET /user`, stored encrypted (Fernet/HKDF).
Without a token, read tools work against public repositories in an
unauthenticated, rate-limited mode — the UI labels this "public mode".
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select

from jarvis.config import get_settings
from jarvis.db.models import Integration
from jarvis.db.session import db_session
from jarvis.security.crypto import decrypt_secret

REPO_RE = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")


class GitHubError(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


async def get_token(user_id: str) -> str | None:
    async with db_session() as db:
        row = (
            (
                await db.execute(
                    select(Integration).where(
                        Integration.user_id == user_id,
                        Integration.provider == "github",
                        Integration.revoked_at.is_(None),
                    )
                )
            )
            .scalars()
            .first()
        )
    if row is None or row.encrypted_token is None:
        return None
    return decrypt_secret(row.encrypted_token)


class GitHubClient:
    def __init__(self, token: str | None) -> None:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "JARVIS-OS",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self.authenticated = token is not None
        self._client = httpx.AsyncClient(base_url=get_settings().github_api_url, headers=headers, timeout=20)

    async def __aenter__(self) -> GitHubClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._client.aclose()

    async def get(self, path: str, **params: Any) -> Any:
        resp = await self._client.get(path, params=params or None)
        if resp.status_code == 404:
            raise GitHubError("Not found (or no access).", 404)
        if resp.status_code in (401, 403):
            remaining = resp.headers.get("x-ratelimit-remaining")
            if remaining == "0":
                raise GitHubError("GitHub API rate limit exhausted; connect a token for higher limits.", 429)
            raise GitHubError(f"GitHub denied access ({resp.status_code}).", resp.status_code)
        resp.raise_for_status()
        return resp.json()

    async def post(self, path: str, json: dict[str, Any]) -> Any:
        resp = await self._client.post(path, json=json)
        if resp.status_code >= 400:
            raise GitHubError(f"GitHub rejected the request ({resp.status_code}): {resp.text[:200]}", resp.status_code)
        return resp.json()


async def client_for(user_id: str) -> GitHubClient:
    return GitHubClient(await get_token(user_id))


async def validate_token(token: str) -> dict[str, Any]:
    async with GitHubClient(token) as gh:
        user = await gh.get("/user")
    return {"login": user["login"], "name": user.get("name"), "checked_at": datetime.now(UTC).isoformat()}


async def repo_overview(user_id: str, repo: str) -> dict[str, Any]:
    if not REPO_RE.match(repo):
        raise GitHubError("Repository must be 'owner/name'.")
    async with await client_for(user_id) as gh:
        info = await gh.get(f"/repos/{repo}")
        pulls = await gh.get(f"/repos/{repo}/pulls", state="open", per_page=10)
        issues = await gh.get(f"/repos/{repo}/issues", state="open", per_page=10)
        try:
            runs = await gh.get(f"/repos/{repo}/actions/runs", per_page=8)
        except GitHubError:
            runs = {"workflow_runs": []}
        mode = "authenticated" if gh.authenticated else "public"
    return {
        "mode": mode,
        "repo": info["full_name"],
        "description": info.get("description"),
        "private": info.get("private"),
        "default_branch": info.get("default_branch"),
        "stars": info.get("stargazers_count"),
        "open_issues_count": info.get("open_issues_count"),
        "pushed_at": info.get("pushed_at"),
        "language": info.get("language"),
        "html_url": info.get("html_url"),
        "pull_requests": [
            {
                "number": p["number"],
                "title": p["title"],
                "author": p["user"]["login"],
                "url": p["html_url"],
                "draft": p.get("draft", False),
                "updated_at": p["updated_at"],
            }
            for p in pulls
        ],
        "issues": [
            {"number": i["number"], "title": i["title"], "url": i["html_url"], "updated_at": i["updated_at"]}
            for i in issues
            if "pull_request" not in i
        ],
        "workflow_runs": [
            {
                "id": r["id"],
                "name": r.get("name"),
                "status": r.get("status"),
                "conclusion": r.get("conclusion"),
                "branch": r.get("head_branch"),
                "event": r.get("event"),
                "url": r.get("html_url"),
                "created_at": r.get("created_at"),
            }
            for r in runs.get("workflow_runs", [])
        ],
    }


async def my_repos(user_id: str) -> list[dict[str, Any]]:
    async with await client_for(user_id) as gh:
        if not gh.authenticated:
            raise GitHubError("Connect a GitHub token to list your repositories.")
        repos = await gh.get("/user/repos", sort="pushed", per_page=30)
    return [
        {
            "full_name": r["full_name"],
            "private": r["private"],
            "pushed_at": r["pushed_at"],
            "open_issues": r["open_issues_count"],
            "language": r.get("language"),
            "url": r["html_url"],
        }
        for r in repos
    ]


async def create_issue(user_id: str, repo: str, title: str, body: str) -> dict[str, Any]:
    if not REPO_RE.match(repo):
        raise GitHubError("Repository must be 'owner/name'.")
    async with await client_for(user_id) as gh:
        if not gh.authenticated:
            raise GitHubError("Creating issues requires a connected GitHub token.")
        issue = await gh.post(f"/repos/{repo}/issues", {"title": title, "body": body})
        verify = await gh.get(f"/repos/{repo}/issues/{issue['number']}")
    return {"number": issue["number"], "url": issue["html_url"], "verified": verify["title"] == title}
