"""CLI: `uv run python -m jarvis.evals [--max-usd 1.0] [--case ID ...]` — spends real API credit."""

from __future__ import annotations

import argparse
import asyncio
import json

from jarvis.evals.runner import run_evals


def main() -> None:
    parser = argparse.ArgumentParser(description="Run JARVIS evaluation cases against the configured model.")
    parser.add_argument("--max-usd", type=float, default=1.0, help="Stop once estimated spend reaches this.")
    parser.add_argument("--case", action="append", help="Run only these case ids (repeatable).")
    args = parser.parse_args()
    report = asyncio.run(run_evals(max_usd=args.max_usd, case_ids=args.case))
    for r in report["results"]:
        print(f"{'PASS' if r['passed'] else 'FAIL'}  {r['id']:<16} {r['category']:<15} {r['reason']}")
    print(json.dumps({k: report[k] for k in ("provider", "model", "passed", "total", "pass_rate", "cost_usd")}))


if __name__ == "__main__":
    main()
