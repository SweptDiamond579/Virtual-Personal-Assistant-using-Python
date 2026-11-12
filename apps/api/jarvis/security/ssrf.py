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

import httpcore
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
    if port not in ALLOWED_PORTS and not get_settings().private_network_allowed:
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
    content: bytes = b""
    headers: dict[str, str] | None = None


class PinnedBackend(httpcore.AsyncNetworkBackend):
    """Connects only to addresses that passed `check_url` (defeats DNS rebinding).

    The hostname stays in the URL, so the Host header, SNI and certificate
    verification use the real name, while the TCP connection goes to the IP that
    was checked. Hosts that were never checked cannot be connected to at all.
    When an outbound HTTP proxy is configured, the proxy itself is the only direct
    connection and the proxy resolves the target (documented in docs/SECURITY.md).
    """

    def __init__(self, pins: dict[str, str], passthrough: set[str] | None = None) -> None:
        self.pins = pins
        self.passthrough = passthrough or set()
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[no-untyped-def]
        target = self.pins.get(host.lower().strip("."))
        if target is None:
            if host not in self.passthrough:
                raise httpcore.ConnectError(f"refusing to connect to unchecked host {host!r}")
            target = host
        return await self._inner.connect_tcp(
            target, port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):  # type: ignore[no-untyped-def]
        raise httpcore.ConnectError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


def _proxy_hosts() -> set[str]:
    import os
    from urllib.parse import urlsplit as _split

    hosts = set()
    for var in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        if os.environ.get(var):
            h = _split(os.environ[var]).hostname
            if h:
                hosts.add(h)
    return hosts


class PinnedTransport(httpx.AsyncHTTPTransport):
    def __init__(self, pins: dict[str, str], **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.backend = PinnedBackend(pins, passthrough=_proxy_hosts())
        self._pool._network_backend = self.backend  # httpcore 1.x connection pool


def pinned_client(pins: dict[str, str], *, timeout: float, headers: dict[str, str] | None = None) -> httpx.AsyncClient:
    transport = PinnedTransport(pins)
    # Environment proxies are respected; each proxy mount also gets the pinning backend.
    client = httpx.AsyncClient(transport=transport, follow_redirects=False, timeout=timeout, headers=headers)
    for mount in client._mounts.values():  # noqa: SLF001
        if mount is not None and hasattr(mount, "_pool"):
            mount._pool._network_backend = transport.backend  # type: ignore[attr-defined]
    return client


async def safe_fetch(url: str, *, max_bytes: int = 1_500_000, timeout: float = 15.0) -> FetchResult:
    """GET a public URL with SSRF checks on every redirect hop, IP pinning and a hard size cap."""
    current = url
    pins: dict[str, str] = {}
    async with pinned_client(
        pins, timeout=timeout, headers={"User-Agent": "JARVIS-OS/0.1 (+personal assistant)"}
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            checked = await check_url(current)
            pins[checked.host] = checked.addresses[0]
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
                    content=body,
                    headers={k.lower(): v for k, v in resp.headers.items()},
                )
    raise UnsafeURLError("too many redirects")
