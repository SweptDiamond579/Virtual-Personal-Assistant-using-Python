"""Controlled browser automation with Playwright.

Each snapshot uses a brand-new, isolated browser context (no cookies or storage
from previous tasks), JavaScript enabled, downloads disabled, service workers
blocked, and every request — including sub-resources and redirects — is checked
against the SSRF guard so pages cannot pivot into the private network.
"""

from __future__ import annotations

import asyncio
import uuid

from playwright.async_api import Route, async_playwright

from jarvis.config import get_settings
from jarvis.security.ssrf import UnsafeURLError, check_url
from jarvis.tools.base import ToolResult

MAX_TEXT = 12000
_lock = asyncio.Semaphore(2)  # resource limit: at most two concurrent browser tasks


async def snapshot(url: str, *, user_id: str) -> ToolResult:
    try:
        await check_url(url)
    except UnsafeURLError as exc:
        return ToolResult.fail(f"Blocked: {exc}")
    shots = get_settings().jarvis_data_dir / "artifacts" / user_id
    shots.mkdir(parents=True, exist_ok=True)
    async with _lock, async_playwright() as pw:
        browser = await pw.chromium.launch()
        try:
            context = await browser.new_context(
                accept_downloads=False,
                service_workers="block",
                java_script_enabled=True,
                viewport={"width": 1280, "height": 900},
                user_agent="JARVIS-OS/0.1 (headless research)",
            )

            async def guard(route: Route) -> None:
                req_url = route.request.url
                if req_url.startswith(("data:", "blob:")):
                    await route.continue_()
                    return
                try:
                    await check_url(req_url)
                except UnsafeURLError:
                    await route.abort("blockedbyclient")
                    return
                await route.continue_()

            await context.route("**/*", guard)
            page = await context.new_page()
            resp = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(500)
            title = await page.title()
            text = await page.evaluate("() => document.body ? document.body.innerText : ''")
            name = f"{uuid.uuid4().hex}.png"
            await page.screenshot(path=str(shots / name), full_page=False)
            status = resp.status if resp else None
        finally:
            await browser.close()
    return ToolResult(
        ok=status is not None and status < 400,
        summary=f"Rendered {url} — “{title[:80]}” (HTTP {status})",
        data={
            "url": url,
            "title": title,
            "status": status,
            "text": text[:MAX_TEXT],
            "truncated": len(text) > MAX_TEXT,
            "screenshot": f"/api/artifacts/{name}",
        },
        untrusted=True,
    )
