"""Advisor Agent endpoints."""
import json
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from app.agents.advisor_agent import recommend_advisors
from app.schemas.advisors import AdvisorProfile, AdvisorMatchRequest

router = APIRouter(prefix="/api/v1/advisors", tags=["advisors"])


def get_advisor_data_path() -> Path:
    return Path(os.environ.get("ADVISOR_DATA_PATH", "data/seed/advisors_extracted_all_609.json"))


def load_profiles() -> list[AdvisorProfile]:
    path = get_advisor_data_path()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [AdvisorProfile.model_validate(item) for item in raw]
    except (OSError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=503, detail="教師資料無法讀取或格式錯誤") from None


@router.get("")
def list_advisors():
    profiles = load_profiles()
    return {"count": len(profiles), "advisors": profiles}


@router.post("/match")
def match_advisors(request: AdvisorMatchRequest):
    profiles = load_profiles()
    if not profiles:
        raise HTTPException(status_code=503, detail="目前沒有教師資料；請先匯入經確認的教師資料")
    return recommend_advisors(request, profiles)
