"""Skill Analysis API 路由。"""

import os
import sqlite3
from pathlib import Path

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.schemas.skill_api import AnalyzeRequest
from app.services.document_parser import DocumentParseError, parse_document
from app.services.enrollment_extractor import extract_enrollments
from app.services.llm_client import ENV_PATH, OpenAIClient
from app.services.skill_analysis import analyze_enrollments

router = APIRouter(prefix="/api/v1/skills", tags=["skills"])


def get_database_path() -> Path:
    load_dotenv(ENV_PATH, override=False)
    return Path(os.environ.get("SKILL_DB_PATH", "data/processed/shared_course_demo.sqlite"))


def get_client_factory():
    def create_client():
        load_dotenv(ENV_PATH, override=False)
        model = os.environ.get("SKILL_LLM_MODEL")
        if not model:
            raise ValueError("模型未設定")
        return OpenAIClient(model=model)
    return create_client


@router.post("/parse")
async def parse_transcript(file: UploadFile = File(...)):
    filename = file.filename or ""
    if Path(filename).suffix.lower() not in {".pdf", ".xlsx"}:
        raise HTTPException(status_code=415, detail="僅支援 PDF 與 XLSX")
    try:
        rows = parse_document(filename, await file.read())
        enrollments, warnings, missing = extract_enrollments(rows)
    except DocumentParseError:
        raise HTTPException(status_code=422, detail="無法解析文件；請確認格式與內容") from None
    finally:
        await file.close()
    return {"status": "needs_confirmation", "enrollments": enrollments, "warnings": warnings, "missing_fields": missing}


@router.post("/analyze")
def analyze(request: AnalyzeRequest, db_path: Path = Depends(get_database_path), client_factory=Depends(get_client_factory)):
    try:
        return analyze_enrollments([item.model_dump() for item in request.enrollments], db_path, client_factory,
                                   scoring_enabled=request.scoring.enabled, numeric_scale=request.scoring.numeric_scale)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="課程資料庫無法使用") from None
