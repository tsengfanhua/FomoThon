from pathlib import Path

from app.mcp_server import list_advisor_profiles


DATA_PATH = Path("data/seed/advisors_extracted_all_609.json")


def test_mcp_lists_normalized_advisors():
    result = list_advisor_profiles(DATA_PATH, 2)

    assert result["status"] == "ok"
    assert result["count"] == 630
    assert len(result["advisors"]) == 2
    assert result["advisors"][0]["teacher_id"]


def test_mcp_rejects_invalid_limit():
    result = list_advisor_profiles(DATA_PATH, 0)

    assert result == {"status": "invalid_limit", "advisors": []}
