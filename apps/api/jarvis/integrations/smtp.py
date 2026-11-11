"""SMTP email sending (works with Gmail/Outlook app passwords or any SMTP relay)."""

from __future__ import annotations

import asyncio
import smtplib
from datetime import UTC, datetime
from email.message import EmailMessage

from jarvis.config import get_settings
from jarvis.db.models import EmailDraft
from jarvis.db.session import db_session
from jarvis.tools.base import ToolResult


def smtp_configured() -> bool:
    s = get_settings()
    return bool(s.smtp_host and s.smtp_from)


def _send_blocking(msg: EmailMessage) -> None:
    s = get_settings()
    assert s.smtp_host
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=30) as conn:
        if s.smtp_starttls:
            conn.starttls()
        if s.smtp_username and s.smtp_password:
            conn.login(s.smtp_username, s.smtp_password.get_secret_value())
        refused = conn.send_message(msg)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)


async def send_draft(user_id: str, draft_id: str) -> ToolResult:
    if not smtp_configured():
        return ToolResult.fail("SMTP is not configured.")
    async with db_session() as db:
        d = await db.get(EmailDraft, draft_id)
        if d is None or d.user_id != user_id:
            return ToolResult.fail("Draft not found.")
        if d.status == "sent":
            # Never resend automatically: a previous attempt may already have been delivered.
            return ToolResult.fail("This draft was already sent; refusing to send it twice.")
        msg = EmailMessage()
        msg["From"] = get_settings().smtp_from
        msg["To"] = d.to
        msg["Subject"] = d.subject
        msg.set_content(d.body)
        try:
            await asyncio.to_thread(_send_blocking, msg)
        except (smtplib.SMTPException, OSError) as exc:
            d.status, d.error = "failed", f"{type(exc).__name__}: {exc}"
            await db.commit()
            return ToolResult.fail(f"Sending failed: {d.error}")
        d.status, d.sent_at = "sent", datetime.now(UTC)
        await db.commit()
    return ToolResult(
        ok=True,
        summary=f"Email sent to {d.to}.",
        data={"draft_id": draft_id},
        verified=True,
        verification="SMTP server accepted the message for all recipients.",
    )
