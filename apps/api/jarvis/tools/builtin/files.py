"""Server-side document workspace (a per-user sandbox directory on the JARVIS server).

All paths are relative to the user's workspace root. Absolute paths, `..`,
symlinks escaping the root, hidden files and oversize content are rejected.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from pydantic import Field

from jarvis.config import get_settings
from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool

MAX_FILE_BYTES = 512 * 1024
MAX_ENTRIES = 500
TEXT_SUFFIXES = {".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".html", ".py", ".ts", ".js", ".log", ".ics"}


class PathError(ValueError):
    pass


def workspace_root(user_id: str) -> Path:
    root = get_settings().jarvis_data_dir / "workspace" / user_id
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def resolve_in_root(root: Path, rel: str) -> Path:
    rel = rel.strip()
    if "\x00" in rel:
        raise PathError("invalid path")
    if rel in ("", ".", "/"):
        return root
    p = Path(rel)
    if p.is_absolute() or rel.startswith(("/", "\\")) or ":" in rel:
        raise PathError("path must be relative to the workspace")
    if any(part in ("..",) for part in p.parts):
        raise PathError("path may not contain '..'")
    if any(part.startswith(".") for part in p.parts):
        raise PathError("hidden files are not accessible")
    candidate = (root / p).resolve()
    if candidate != root and root not in candidate.parents:
        raise PathError("path escapes the workspace")
    return candidate


class ListInput(ToolInput):
    path: str = Field(default="", max_length=400)


@tool(
    name="files_list",
    title="List workspace files",
    description="List files and folders in the JARVIS document workspace (server-side sandbox).",
    input_model=ListInput,
    category="files",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def files_list(args: ListInput, ctx: ToolContext) -> ToolResult:
    root = workspace_root(ctx.user_id)
    try:
        target = resolve_in_root(root, args.path)
    except PathError as exc:
        return ToolResult.fail(str(exc))
    if not target.is_dir():
        return ToolResult.fail("Not a directory.")
    entries = []
    for entry in sorted(os.scandir(target), key=lambda e: e.name)[:MAX_ENTRIES]:
        if entry.name.startswith("."):
            continue
        st = entry.stat(follow_symlinks=False)
        entries.append({"name": entry.name, "kind": "dir" if entry.is_dir() else "file", "size": st.st_size})
    return ToolResult(ok=True, summary=f"{len(entries)} entries in /{args.path}", data={"entries": entries})


class ReadInput(ToolInput):
    path: str = Field(min_length=1, max_length=400)


@tool(
    name="files_read",
    title="Read workspace file",
    description="Read a UTF-8 text file from the JARVIS document workspace.",
    input_model=ReadInput,
    category="files",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def files_read(args: ReadInput, ctx: ToolContext) -> ToolResult:
    root = workspace_root(ctx.user_id)
    try:
        target = resolve_in_root(root, args.path)
    except PathError as exc:
        return ToolResult.fail(str(exc))
    if not target.is_file():
        return ToolResult.fail("File not found.")
    raw = target.read_bytes()[:MAX_FILE_BYTES]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return ToolResult.fail("File is not UTF-8 text.")
    return ToolResult(
        ok=True,
        summary=f"Read {len(raw)} bytes from {args.path}",
        data={"path": args.path, "content": text, "truncated": target.stat().st_size > MAX_FILE_BYTES},
    )


class WriteInput(ToolInput):
    path: str = Field(min_length=1, max_length=400)
    content: str = Field(max_length=MAX_FILE_BYTES)
    overwrite: bool = False


@tool(
    name="files_write",
    title="Write workspace file",
    description=(
        "Create (or, with overwrite=true, replace) a text document in the JARVIS document workspace. "
        "Allowed extensions: .txt .md .csv .json .yaml .html .py .ts .js .log .ics. Requires approval."
    ),
    input_model=WriteInput,
    category="files",
    risk="medium",
    side_effects=True,
    default_policy="ask",
)
async def files_write(args: WriteInput, ctx: ToolContext) -> ToolResult:
    root = workspace_root(ctx.user_id)
    try:
        target = resolve_in_root(root, args.path)
    except PathError as exc:
        return ToolResult.fail(str(exc))
    if target.suffix.lower() not in TEXT_SUFFIXES:
        return ToolResult.fail(f"Extension '{target.suffix}' is not allowed.")
    existed = target.exists()
    if existed and not args.overwrite:
        return ToolResult.fail("File exists; set overwrite=true to replace it.")
    data = args.content.encode("utf-8")
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.jarvis-tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    # Verify the outcome independently: re-read and compare digests.
    ok = hashlib.sha256(target.read_bytes()).hexdigest() == hashlib.sha256(data).hexdigest()
    return ToolResult(
        ok=ok,
        summary=f"{'Replaced' if existed else 'Created'} {args.path} ({len(data)} bytes).",
        data={"path": args.path, "bytes": len(data), "created": not existed},
        verified=ok,
        verification="File re-read from disk and SHA-256 matched the written content.",
    )
