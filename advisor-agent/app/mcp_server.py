"""Advisor Agent MCP stdio server."""
import argparse
import json
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from app.agents.advisor_agent import recommend_advisors
from app.schemas.advisors import AdvisorMatchRequest, AdvisorProfile


DEFAULT_DATA_PATH = "data/seed/advisors_extracted_all_609.json"


def load_profiles(path: Path) -> list[AdvisorProfile]:
    if not path.exists():
        raise FileNotFoundError(f"advisor data file not found: {path}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("advisor data must be a JSON array")
    return [AdvisorProfile.model_validate(item) for item in raw]


def list_advisor_profiles(path: Path, limit: int) -> dict:
    if not 1 <= limit <= 100:
        return {"status": "invalid_limit", "advisors": []}
    profiles = load_profiles(path)
    return {
        "status": "ok",
        "count": len(profiles),
        "advisors": [profile.model_dump(mode="json") for profile in profiles[:limit]],
    }


def match_advisor_profiles(path: Path, request: AdvisorMatchRequest) -> dict:
    profiles = load_profiles(path)
    if not profiles:
        return {"status": "no_advisors", "response": None}
    response = recommend_advisors(request, profiles)
    return {"status": "ok", "response": response.model_dump(mode="json")}


def create_server(data_path: Path) -> FastMCP:
    server = FastMCP(
        "Advisor Agent",
        instructions="教師推薦僅依已提供資料進行文字匹配，不代表教師能力、意願或可指導量能。",
    )

    @server.tool()
    def list_advisors(limit: int = 20) -> dict:
        """列出教師資料；limit 範圍為 1..100。"""
        return list_advisor_profiles(data_path, limit)

    @server.tool()
    def match_advisors(request: AdvisorMatchRequest) -> dict:
        """依競賽主題、技能、相關課程及指導經驗排序教師。"""
        return match_advisor_profiles(data_path, request)

    return server


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data",
        type=Path,
        default=Path(os.environ.get("ADVISOR_DATA_PATH", DEFAULT_DATA_PATH)),
        help="AdvisorProfile JSON path",
    )
    args = parser.parse_args()
    create_server(args.data).run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
