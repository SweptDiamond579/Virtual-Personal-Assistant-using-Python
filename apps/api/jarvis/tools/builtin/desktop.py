"""Desktop actions executed by the paired Tauri companion (which re-validates locally)."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from jarvis.services.devices import DeviceUnavailable, request_action
from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool

ID_PATTERN = r"^[a-z0-9][a-z0-9_.-]{0,63}$"


async def _run(ctx: ToolContext, action: dict[str, Any], summary_ok: str) -> ToolResult:
    try:
        res = await request_action(ctx.user_id, action)
    except DeviceUnavailable as exc:
        return ToolResult.fail(str(exc))
    if not res.get("ok"):
        return ToolResult.fail(f"Desktop refused or failed: {res.get('error', 'unknown error')}")
    return ToolResult(
        ok=True,
        summary=summary_ok,
        data={"result": res.get("result")},
        verified=True,
        verification="Result reported by the desktop companion after local execution.",
    )


class LaunchInput(ToolInput):
    app_id: str = Field(pattern=ID_PATTERN, description="An app id from the desktop policy allow-list.")


@tool(
    name="desktop_launch_app",
    title="Launch desktop app",
    description="Launch an application from the desktop companion's allow-list (no arbitrary commands).",
    input_model=LaunchInput,
    category="desktop",
    risk="medium",
    side_effects=True,
    default_policy="ask",
    requires={"desktop"},
)
async def desktop_launch_app(args: LaunchInput, ctx: ToolContext) -> ToolResult:
    return await _run(ctx, {"action": "launch_app", "app_id": args.app_id}, f"Launched {args.app_id} on the desktop.")


class DirInput(ToolInput):
    root_id: str = Field(pattern=ID_PATTERN, description="Authorised root id from the desktop policy.")
    path: str = Field(default="", max_length=400)


@tool(
    name="desktop_list_dir",
    title="List desktop folder",
    description="List a folder inside an authorised desktop root directory.",
    input_model=DirInput,
    category="desktop",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    requires={"desktop"},
)
async def desktop_list_dir(args: DirInput, ctx: ToolContext) -> ToolResult:
    return await _run(ctx, {"action": "list_dir", "root_id": args.root_id, "path": args.path}, "Listed desktop folder.")


class FileInput(ToolInput):
    root_id: str = Field(pattern=ID_PATTERN)
    path: str = Field(min_length=1, max_length=400)


@tool(
    name="desktop_read_file",
    title="Read desktop file",
    description="Read a text file inside an authorised desktop root directory.",
    input_model=FileInput,
    category="desktop",
    risk="low",
    side_effects=False,
    default_policy="ask",
    requires={"desktop"},
)
async def desktop_read_file(args: FileInput, ctx: ToolContext) -> ToolResult:
    return await _run(ctx, {"action": "read_text_file", "root_id": args.root_id, "path": args.path}, "Read file.")


class WriteInput(ToolInput):
    root_id: str = Field(pattern=ID_PATTERN)
    path: str = Field(min_length=1, max_length=400)
    content: str = Field(max_length=512 * 1024)
    overwrite: bool = False


@tool(
    name="desktop_write_file",
    title="Write desktop file",
    description=(
        "Create or overwrite a text file inside a writable authorised desktop root. Requires approval on the desktop."
    ),
    input_model=WriteInput,
    category="desktop",
    risk="high",
    side_effects=True,
    default_policy="ask",
    requires={"desktop"},
    approval_client_kind="desktop",
)
async def desktop_write_file(args: WriteInput, ctx: ToolContext) -> ToolResult:
    return await _run(
        ctx,
        {
            "action": "write_text_file",
            "root_id": args.root_id,
            "path": args.path,
            "content": args.content,
            "overwrite": args.overwrite,
        },
        f"Wrote {args.path} on the desktop.",
    )


class OrganizeInput(ToolInput):
    root_id: str = Field(pattern=ID_PATTERN)
    path: str = Field(default="", max_length=400)
    dry_run: bool = True


@tool(
    name="desktop_organize_folder",
    title="Organise desktop folder",
    description=(
        "Sort files in a desktop folder into category subfolders (Documents, Images, …). "
        "Use dry_run=true first to preview the plan. Applying requires approval on the desktop."
    ),
    input_model=OrganizeInput,
    category="desktop",
    risk="high",
    side_effects=True,
    default_policy="ask",
    requires={"desktop"},
    approval_client_kind="desktop",
)
async def desktop_organize_folder(args: OrganizeInput, ctx: ToolContext) -> ToolResult:
    return await _run(
        ctx,
        {"action": "organize_by_type", "root_id": args.root_id, "path": args.path, "dry_run": args.dry_run},
        "Previewed organisation plan." if args.dry_run else "Organised folder.",
    )
