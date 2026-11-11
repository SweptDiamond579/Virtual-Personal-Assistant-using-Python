"""SSRF protection for every outbound request whose URL is influenced by a model or a user.

Rules: http/https only, no credentials in the URL, standard ports only, and the
hostname must resolve exclusively to public addresses. Resolution happens here
and the caller connects to the hostname immediately after; redirects are
re-validated hop by hop by `safe_fetch`.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from jarvis.config import get_settings

ALLOWED_SCHEMES = {"http", "https"}
ALLOWED_PORTS = {None, 80, 443, 8080, 8443}
MAX_REDIRECTS = 4


class UnsafeURLError(ValueError):
    pass


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10"))
    )


@dataclass(frozen=True)
class CheckedURL:
    url: str
    host: str
    addresses: tuple[str, ...]


async def check_url(url: str) -> CheckedURL:
    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnsafeURLError(f"scheme '{parts.scheme}' is not allowed")
    if parts.username or parts.password:
        raise UnsafeURLError("credentials in URLs are not allowed")
    host = (parts.hostname or "").strip(".").lower()
    if not host:
        raise UnsafeURLError("URL has no host")
    try:
        port = parts.port
    except ValueError as exc:
        raise UnsafeURLError("invalid port") from exc
    if port not in ALLOWED_PORTS:
        raise UnsafeURLError(f"port {port} is not allowed")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        if not get_settings().private_network_allowed:
            raise UnsafeURLError("local hostnames are not allowed")

    try:
        literal = ipaddress.ip_address(host)
        addrs = [literal]
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise UnsafeURLError(f"cannot resolve host '{host}'") from exc
        addrs = [ipaddress.ip_address(info[4][0]) for info in infos]

    if not get_settings().private_network_allowed:
        bad = [str(a) for a in addrs if not _is_public(a)]
        if bad:
            raise UnsafeURLError(f"host '{host}' resolves to a non-public address")
    return CheckedURL(url=url.strip(), host=host, addresses=tuple(sorted({str(a) for a in addrs})))


@dataclass
class FetchResult:
    url: str
    status: int
    content_type: str
    text: str
    truncated: bool


async def safe_fetch(url: str, *, max_bytes: int = 1_500_000, timeout: float = 15.0) -> FetchResult:
    """GET a public URL with SSRF checks on every redirect hop and a hard size cap."""
    current = url
    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        headers={"User-Agent": "JARVIS-OS/0.1 (+personal assistant)"},
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            checked = await check_url(current)
            async with client.stream("GET", checked.url) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location")
                    if not location:
                        raise UnsafeURLError("redirect without location")
                    current = urljoin(checked.url, location)
                    continue
                chunks: list[bytes] = []
                size = 0
                truncated = False
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        chunks.append(chunk[: max(0, max_bytes - (size - len(chunk)))])
                        truncated = True
                        break
                    chunks.append(chunk)
                body = b"".join(chunks)
                encoding = resp.encoding or "utf-8"
                return FetchResult(
                    url=str(resp.url),
                    status=resp.status_code,
                    content_type=resp.headers.get("content-type", ""),
                    text=body.decode(encoding, errors="replace"),
                    truncated=truncated,
                )
    raise UnsafeURLError("too many redirects")
