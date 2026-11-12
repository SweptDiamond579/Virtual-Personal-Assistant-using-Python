"""Development tools backed by the GitHub integration."""

from __future__ import annotations

from pydantic import Field

from jarvis.integrations import github
from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool


class RepoInput(ToolInput):
    repo: str = Field(pattern=r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$", description="owner/name")


@tool(
    name="github_repo_overview",
    title="GitHub repository overview",
    description=(
        "Summarise a GitHub repository: metadata, open pull requests, open issues and recent CI workflow runs. "
        "Works for public repos without a token; private repos need a connected token."
    ),
    input_model=RepoInput,
    category="development",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    untrusted_output=True,  # issue/PR titles are user-generated external content
    retryable=True,
)
async def github_repo_overview(args: RepoInput, ctx: ToolContext) -> ToolResult:
    try:
        data = await github.repo_overview(ctx.user_id, args.repo)
    except github.GitHubError as exc:
        return ToolResult.fail(str(exc))
    failing = [r for r in data["workflow_runs"] if r["conclusion"] == "failure"]
    summary = (
        f"{data['repo']}: {len(data['pull_requests'])} open PRs, {len(data['issues'])} open issues, "
        f"{len(failing)} failing recent runs ({data['mode']} mode)"
    )
    return ToolResult(ok=True, summary=summary, data=data, untrusted=True)


class NoInput(ToolInput):
    pass


@tool(
    name="github_list_my_repos",
    title="List my GitHub repositories",
    description="List the connected GitHub account's repositories, most recently pushed first.",
    input_model=NoInput,
    category="development",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    requires={"github"},
    retryable=True,
)
async def github_list_my_repos(args: NoInput, ctx: ToolContext) -> ToolResult:
    try:
        repos = await github.my_repos(ctx.user_id)
    except github.GitHubError as exc:
        return ToolResult.fail(str(exc))
    return ToolResult(ok=True, summary=f"{len(repos)} repositories.", data={"repos": repos})


class IssueInput(ToolInput):
    repo: str = Field(pattern=r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
    title: str = Field(min_length=3, max_length=256)
    body: str = Field(default="", max_length=20000)


@tool(
    name="github_create_issue",
    title="Create GitHub issue",
    description="Open a new issue in a repository using the connected GitHub token. Requires approval.",
    input_model=IssueInput,
    category="development",
    risk="high",
    side_effects=True,
    default_policy="ask",
    requires={"github"},
)
async def github_create_issue(args: IssueInput, ctx: ToolContext) -> ToolResult:
    try:
        res = await github.create_issue(ctx.user_id, args.repo, args.title, args.body)
    except github.GitHubError as exc:
        return ToolResult.fail(str(exc))
    return ToolResult(
        ok=True,
        summary=f"Opened issue #{res['number']} in {args.repo}.",
        data=res,
        verified=res["verified"],
        verification="Issue re-fetched from GitHub after creation.",
    )


class FileChange(ToolInput):
    path: str = Field(min_length=1, max_length=300)
    content: str = Field(max_length=200_000)


class ProposeInput(ToolInput):
    repo: str = Field(pattern=r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
    branch: str = Field(pattern=r"^jarvis/[A-Za-z0-9._/-]{1,80}$", description="New branch, must start with jarvis/")
    title: str = Field(min_length=5, max_length=200)
    body: str = Field(default="", max_length=20000, description="What changes and why, plus how it was checked.")
    files: list[FileChange] = Field(min_length=1, max_length=20, description="Full new contents of each file.")
    base: str | None = Field(default=None, max_length=100, description="Base branch (default: repository default)")


@tool(
    name="github_propose_change",
    title="Propose code change (draft PR)",
    description=(
        "Create a new jarvis/* branch with one commit containing the given files and open a DRAFT pull request for "
        "human review. Never pushes to existing branches, never merges, cannot modify CI workflows. Requires approval."
    ),
    input_model=ProposeInput,
    category="development",
    risk="high",
    side_effects=True,
    default_policy="ask",
    requires={"github"},
    timeout_s=90,
)
async def github_propose_change(args: ProposeInput, ctx: ToolContext) -> ToolResult:
    try:
        res = await github.propose_change(
            ctx.user_id,
            args.repo,
            base=args.base,
            branch=args.branch,
            title=args.title,
            body=args.body,
            files=[f.model_dump() for f in args.files],
        )
    except github.GitHubError as exc:
        return ToolResult.fail(str(exc))
    return ToolResult(
        ok=True,
        summary=f"Opened draft PR #{res['number']} in {args.repo} from {res['branch']}.",
        data=res,
        verified=res["verified"],
        verification="PR re-fetched: draft, head branch and commit match.",
    )
