"""從已確認的成績單執行課程與 ESCO 分析。"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.esco.repository import EscoRepository
from app.services.document_parser import parse_document
from app.services.enrollment_extractor import extract_enrollments
from app.services.esco_profile import analyze_esco_enrollments
from app.services.llm_client import OpenAIClient


def main():
    parser = argparse.ArgumentParser(description="分析已人工確認的成績單；呼叫模型可能產生費用")
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--course-db", type=Path, required=True)
    parser.add_argument("--esco-db", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--confirmed", action="store_true", required=True,
                        help="確認輸入紀錄及課綱送交模型的權限")
    args = parser.parse_args()
    records, warnings, missing = extract_enrollments(parse_document(args.transcript.name, args.transcript.read_bytes()))
    if warnings or missing:
        raise SystemExit("成績單欄位需先確認，無法開始分析")
    result = analyze_esco_enrollments(records, args.course_db, EscoRepository(args.esco_db), OpenAIClient(args.model))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
