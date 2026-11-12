"""Draft-PR change proposals against mocked GitHub Git Data API responses."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from jarvis.config import get_settings
from jarvis.integrations import github
from tests.conftest import AuthedClient

REPO = "acme/rocket"


def mock_repo(router: respx.MockRouter, *, branch_exists: bool = False) -> dict:
    base = get_settings().github_api_url
    calls: dict = {}
    router.get(f"{base}/repos/{REPO}").mock(return_value=httpx.Response(200, json={"default_branch": "main"}))
    router.get(f"{base}/repos/{REPO}/git/ref/heads/jarvis/fix-typo").mock(
        return_value=httpx.Response(200, json={"object": {"sha": "x"}}) if branch_exists else httpx.Response(404)
    )
    router.get(f"{base}/repos/{REPO}/git/ref/heads/main").mock(
        return_value=httpx.Response(200, json={"object": {"sha": "base123"}})
    )
    router.get(f"{base}/repos/{REPO}/git/commits/base123").mock(
        return_value=httpx.Response(200, json={"tree": {"sha": "tree0"}})
    )

    def capture(name: str, response: dict):  # noqa: ANN202
        def handler(request: httpx.Request) -> httpx.Response:
            calls[name] = json.loads(request.content)
            return httpx.Response(201, json=response)

        return handler

    router.post(f"{base}/repos/{REPO}/git/trees").mock(side_effect=capture("tree", {"sha": "tree1"}))
    router.post(f"{base}/repos/{REPO}/git/commits").mock(side_effect=capture("commit", {"sha": "commit1"}))
    router.post(f"{base}/repos/{REPO}/git/refs").mock(side_effect=capture("ref", {"ref": "refs/heads/jarvis/fix-typo"}))
    router.post(f"{base}/repos/{REPO}/pulls").mock(
        side_effect=capture("pr", {"number": 7, "html_url": "https://github.com/acme/rocket/pull/7"})
    )
    router.get(f"{base}/repos/{REPO}/pulls/7").mock(
        return_value=httpx.Response(200, json={"draft": True, "head": {"ref": "jarvis/fix-typo", "sha": "commit1"}})
    )
    return calls


@respx.mock
async def test_propose_change_creates_branch_commit_and_draft_pr(monkeypatch: pytest.MonkeyPatch) -> None:
    async def token(_: str) -> str:
        return "ghp_test"

    monkeypatch.setattr(github, "get_token", token)
    calls = mock_repo(respx.mock)
    res = await github.propose_change(
        "u",
        REPO,
        base=None,
        branch="jarvis/fix-typo",
        title="Fix typo in README",
        body="Corrects a typo.",
        files=[{"path": "README.md", "content": "Hello\n"}],
    )
    assert res["number"] == 7 and res["verified"] is True and res["base"] == "main"
    assert calls["tree"] == {
        "base_tree": "tree0",
        "tree": [{"path": "README.md", "mode": "100644", "type": "blob", "content": "Hello\n"}],
    }
    assert calls["commit"]["parents"] == ["base123"]
    assert calls["ref"] == {"ref": "refs/heads/jarvis/fix-typo", "sha": "commit1"}  # new ref, never a force update
    assert calls["pr"]["draft"] is True and calls["pr"]["head"] == "jarvis/fix-typo"


@respx.mock
async def test_propose_change_never_overwrites_existing_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    async def token(_: str) -> str:
        return "ghp_test"

    monkeypatch.setattr(github, "get_token", token)
    calls = mock_repo(respx.mock, branch_exists=True)
    with pytest.raises(github.GitHubError, match="already exists"):
        await github.propose_change(
            "u",
            REPO,
            base=None,
            branch="jarvis/fix-typo",
            title="Fix typo",
            body="",
            files=[{"path": "README.md", "content": "x"}],
        )
    assert calls == {}  # nothing was written


@pytest.mark.parametrize("path", [".github/workflows/ci.yml", "../etc/passwd", "/abs.txt", ".git/config", "a//b"])
def test_protected_and_invalid_paths(path: str) -> None:
    assert github.validate_change_path(path) is not None


async def test_propose_requires_github_and_approval(owner: AuthedClient) -> None:
    from jarvis.tools.base import registry

    spec = registry.get("github_propose_change")
    assert spec is not None and spec.risk == "high" and spec.default_policy == "ask" and "github" in spec.requires
