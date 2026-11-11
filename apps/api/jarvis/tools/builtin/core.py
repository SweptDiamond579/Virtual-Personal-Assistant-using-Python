"""Information tools with no side effects."""

from __future__ import annotations

import ast
import math
import operator
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field

from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool


class TimeInput(ToolInput):
    timezone: str | None = Field(default=None, description="IANA timezone, e.g. Europe/London. Defaults to UTC.")


@tool(
    name="get_current_time",
    title="Current time",
    description="Get the current date and time, optionally in a specific IANA timezone.",
    input_model=TimeInput,
    category="info",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def get_current_time(args: TimeInput, ctx: ToolContext) -> ToolResult:
    tz = UTC
    if args.timezone:
        try:
            tz = ZoneInfo(args.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            return ToolResult.fail(f"Unknown timezone '{args.timezone}'.")
    now = datetime.now(tz)
    return ToolResult(
        ok=True,
        summary=now.strftime("%A %d %B %Y, %H:%M %Z"),
        data={"iso": now.isoformat(), "timezone": str(tz), "weekday": now.strftime("%A")},
        verified=True,
    )


_BIN = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UN = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "log": math.log,
    "log10": math.log10,
    "exp": math.exp,
    "abs": abs,
    "round": round,
    "floor": math.floor,
    "ceil": math.ceil,
    "min": min,
    "max": max,
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}


def safe_eval(expr: str) -> float:
    """Evaluate arithmetic without `eval`: whitelisted AST nodes only, bounded exponents."""
    tree = ast.parse(expr, mode="eval")

    def ev(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int | float):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and (abs(right) > 1000 or abs(left) > 1e6):
                raise ValueError("exponent too large")
            return _BIN[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UN:
            return _UN[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
            if node.keywords or len(node.args) > 4:
                raise ValueError("unsupported call")
            return _FUNCS[node.func.id](*[ev(a) for a in node.args])
        raise ValueError(f"unsupported expression element: {type(node).__name__}")

    if len(expr) > 300:
        raise ValueError("expression too long")
    return ev(tree)


class CalcInput(ToolInput):
    expression: str = Field(description="Arithmetic expression, e.g. '(42 * 1.2) / sqrt(9)'.", max_length=300)


@tool(
    name="calculate",
    title="Calculator",
    description="Evaluate an arithmetic expression exactly (supports + - * / // % **, sqrt, sin, cos, log, pi, e).",
    input_model=CalcInput,
    category="info",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def calculate(args: CalcInput, ctx: ToolContext) -> ToolResult:
    try:
        value = safe_eval(args.expression)
    except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, TypeError) as exc:
        return ToolResult.fail(f"Could not evaluate: {exc}")
    return ToolResult(ok=True, summary=f"{args.expression} = {value:g}", data={"result": value}, verified=True)
