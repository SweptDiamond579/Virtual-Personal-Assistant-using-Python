"""Provider factory, model routing and pricing."""

from __future__ import annotations

import re
from dataclasses import dataclass

from jarvis.config import Settings, get_settings
from jarvis.providers.base import ModelProvider, ProviderError

# USD per million tokens: (input, output, cache_read). Cache writes bill at 1.25x input.
PRICING: dict[str, tuple[float, float, float]] = {
    "claude-fable-5-2": (8.0, 40.0, 0.20),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 0.10),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "scripted-test-double": (0.0, 0.0, 0.0),
}
UNKNOWN_MODEL_PRICING = (5.0, 25.0, 0.50)  # conservative default for budget enforcement


def estimate_cost(
    model: str, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_write: int = 0
) -> float:
    pin, pout, pcache = PRICING.get(model, UNKNOWN_MODEL_PRICING)
    return (input_tokens * pin + output_tokens * pout + cache_read * pcache + cache_write * pin * 1.25) / 1e6


def build_provider(settings: Settings | None = None) -> ModelProvider | None:
    s = settings or get_settings()
    kind = s.resolved_provider()
    if kind == "anthropic":
        if not (s.anthropic_api_key and s.anthropic_api_key.get_secret_value()):
            return None
        from jarvis.providers.anthropic_provider import AnthropicProvider

        return AnthropicProvider(
            s.anthropic_api_key.get_secret_value(),
            model=s.anthropic_model,
            fast_model=s.anthropic_fast_model,
            effort=s.anthropic_effort,
            refusal_fallback=s.anthropic_refusal_fallback,
        )
    if kind == "openai_compatible":
        if not (s.openai_compat_base_url and s.openai_compat_model):
            return None
        from jarvis.providers.openai_compat import OpenAICompatProvider

        key = s.openai_compat_api_key.get_secret_value() if s.openai_compat_api_key else None
        return OpenAICompatProvider(s.openai_compat_base_url, key, s.openai_compat_model)
    if kind == "scripted":
        from jarvis.providers.scripted import ScriptedProvider

        return ScriptedProvider()
    return None


_COMPLEX = re.compile(
    r"\b(code|debug|refactor|analy[sz]e|plan|research|compare|design|architect|explain|why|"
    r"write|draft|summari[sz]e|review|investigate|workflow|organi[sz]e|report)\b",
    re.I,
)


@dataclass
class Route:
    model: str
    effort: str | None
    reason: str


def route_model(provider: ModelProvider, text: str, settings: Settings | None = None) -> Route:
    """Cheap heuristic routing: short, simple requests go to the fast model."""
    s = settings or get_settings()
    primary = provider.default_model()
    if s.jarvis_model_routing != "auto" or provider.name != "anthropic":
        return Route(primary, None, "fixed routing")
    if len(text) < 160 and not _COMPLEX.search(text):
        return Route(provider.default_model(fast=True), "low", "short simple request")
    return Route(primary, None, "complex or long request")


__all__ = ["PRICING", "ProviderError", "Route", "build_provider", "estimate_cost", "route_model"]
