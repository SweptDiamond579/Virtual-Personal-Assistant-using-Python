"""Sandboxed project checks (tests, linters, type checks) for registered projects.

- Projects are registered by the user in Settings (`dev_projects`); tools cannot register them.
- Only predefined argv templates run — no shell, no model-supplied arguments.
- The child gets a scrubbed environment (no API keys or JARVIS secrets), its own process
  group, CPU/file-size limits and a wall-clock timeout that kills the whole group.
- Output is untrusted (a test can print anything) and truncated.
Running a project's tests executes that project's code, so the tool is high risk and
always requires approval.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import time
from pathlib import Path
from typing import Literal

from pydantic import Field

from jarvis.db.session import db_session
from jarvis.services.settings_store import get_setting
from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool

CheckName = Literal["pytest", "ruff", "npm_test", "pnpm_test", "tsc", "cargo_test", "go_test"]
TIMEOUT_S = 300
OUTPUT_CHARS = 6000
SAFE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "UV_CACHE_DIR", "CARGO_HOME", "RUSTUP_HOME", "GOPATH")


def _python(project: Path) -> str:
    venv = project / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else (shutil.which("python3") or "python3")


def check_argv(check: str, project: Path) -> list[str] | None:
    """The fixed command for a check, or None if it does not apply to this project."""
    has = lambda name: (project / name).exists()  # noqa: E731
    if check == "pytest" and (has("pyproject.toml") or has("pytest.ini") or has("setup.cfg") or has("tests")):
        if has("uv.lock") and not has(".venv") and shutil.which("uv"):
            return ["uv", "run", "--frozen", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"]
        return [_python(project), "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"]
    if check == "ruff" and (has("pyproject.toml") or has("ruff.toml")):
        return [_python(project), "-m", "ruff", "check", "."]
    if check == "npm_test" and has("package.json") and not has("pnpm-lock.yaml"):
        return ["npm", "test", "--silent"]
    if check == "pnpm_test" and has("pnpm-lock.yaml"):
        return ["pnpm", "test"]
    if check == "tsc" and has("tsconfig.json"):
        return ["npx", "--no-install", "tsc", "--noEmit"]
    if check == "cargo_test" and has("Cargo.toml"):
        return ["cargo", "test", "--quiet"]
    if check == "go_test" and has("go.mod"):
        return ["go", "test", "./..."]
    return None


def available_checks(project: Path) -> list[str]:
    return [c for c in CheckName.__args__ if check_argv(c, project) is not None]  # type: ignore[attr-defined]


def scrubbed_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in SAFE_ENV_KEYS if k in os.environ}
    env.update({"CI": "1", "TERM": "dumb", "NO_COLOR": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    return env


def _limits() -> None:  # runs in the child before exec
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_S * 2, TIMEOUT_S * 2))
    resource.setrlimit(resource.RLIMIT_FSIZE, (200 * 1024 * 1024, 200 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


async def run_check(argv: list[str], cwd: Path, timeout_s: float = TIMEOUT_S) -> tuple[int | None, str, float]:
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=scrubbed_env(),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
        preexec_fn=_limits,  # noqa: PLW1509 — sets rlimits only; no locks or threads involved
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        code: int | None = proc.returncode
    except TimeoutError:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, code = (await proc.communicate())[0] or b"", None
    return code, out.decode(errors="replace"), time.monotonic() - started


async def registered_projects(user_id: str) -> dict[str, Path]:
    async with db_session() as db:
        projects = await get_setting(db, user_id, "dev_projects") or []
    return {p["id"]: Path(p["path"]) for p in projects if isinstance(p, dict) and "id" in p and "path" in p}


class NoInput(ToolInput):
    pass


@tool(
    name="dev_list_projects",
    title="List development projects",
    description="List the local projects the user registered for checks, with the checks available for each.",
    input_model=NoInput,
    category="development",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
)
async def dev_list_projects(args: NoInput, ctx: ToolContext) -> ToolResult:
    projects = await registered_projects(ctx.user_id)
    items = [{"id": pid, "checks": available_checks(path) if path.is_dir() else []} for pid, path in projects.items()]
    return ToolResult(ok=True, summary=f"{len(items)} registered project(s).", data={"projects": items})


class CheckInput(ToolInput):
    project_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_.-]{0,63}$")
    check: CheckName


@tool(
    name="dev_run_checks",
    title="Run project check",
    description=(
        "Run one predefined check (pytest, ruff, npm_test, pnpm_test, tsc, cargo_test, go_test) in a project the user "
        "registered. Executes the project's own code in a restricted subprocess; requires approval. "
        "Output is untrusted."
    ),
    input_model=CheckInput,
    category="development",
    risk="high",
    side_effects=True,
    default_policy="ask",
    untrusted_output=True,
    timeout_s=TIMEOUT_S + 30,
)
async def dev_run_checks(args: CheckInput, ctx: ToolContext) -> ToolResult:
    projects = await registered_projects(ctx.user_id)
    path = projects.get(args.project_id)
    if path is None or not path.is_dir():
        return ToolResult.fail(f"Unknown project '{args.project_id}'. Register it in Settings → Development.")
    argv = check_argv(args.check, path)
    if argv is None:
        return ToolResult.fail(f"'{args.check}' does not apply to this project. Available: {available_checks(path)}")
    if shutil.which(argv[0]) is None and not os.path.exists(argv[0]):  # noqa: ASYNC240 — instant stat
        return ToolResult.fail(f"'{argv[0]}' is not installed on the JARVIS server.")
    code, output, seconds = await run_check(argv, path)
    tail = output[-OUTPUT_CHARS:]
    status = "timed out" if code is None else ("passed" if code == 0 else f"failed (exit {code})")
    return ToolResult(
        ok=code is not None,
        summary=f"{args.check} in {args.project_id}: {status} in {seconds:.1f}s",
        data={
            "project": args.project_id,
            "check": args.check,
            "command": " ".join(argv[-6:]),
            "exit_code": code,
            "passed": code == 0,
            "seconds": round(seconds, 1),
            "output_tail": tail,
            "truncated": len(output) > OUTPUT_CHARS,
        },
        untrusted=True,
        verified=True,
        verification="Exit code reported by the process itself.",
    )
