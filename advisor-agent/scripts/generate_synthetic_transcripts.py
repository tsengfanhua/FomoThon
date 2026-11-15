"""使用固定的完全合成資料產生成績單，與本機受保護的課程代號對應。"""

import json
import os
from pathlib import Path

from openpyxl import Workbook
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


STUDENTS = {
    "student_demo_001": [("course_001", "程式設計基礎", 86), ("course_002", "資料庫概念與設計", 79), ("course_008", "資料結構程式實作", 83), ("course_009", "演算法設計基礎", 81), ("course_013", "網路程式開發", 85), ("course_010", "網路安全治理", 78)],
    "student_demo_002": [("course_001", "程式設計基礎", 88), ("course_003", "機率與資料推論", 91), ("course_005", "人工智慧應用概論", 89), ("course_006", "統計推論方法", 85), ("course_011", "資料分析與視覺化", 90), ("course_014", "深度學習與神經網路", 87)],
    "student_demo_003": [("course_003", "機率與資料推論", 77), ("course_004", "運算方法與設計應用", 84), ("course_007", "資料探勘與應用", 80), ("course_011", "資料分析與視覺化", 88), ("course_012", "數位圖像技術", 86), ("course_016", "視覺創意設計", 92)],
    "student_demo_004": [("course_004", "運算方法與設計應用", 82), ("course_005", "人工智慧應用概論", 78), ("course_012", "數位圖像技術", 90), ("course_014", "深度學習與神經網路", 83), ("course_015", "敏捷方法與專案管理", 88), ("course_016", "視覺創意設計", 91)],
    "student_demo_005": [("course_001", "程式設計基礎", 80), ("course_002", "資料庫概念與設計", 85), ("course_006", "統計推論方法", 82), ("course_007", "資料探勘與應用", 88), ("course_011", "資料分析與視覺化", 87), ("course_013", "網路程式開發", 79), ("course_015", "敏捷方法與專案管理", 90)],
}
ANOMALIES = {
    "case_missing_grade": [("course_001", "程式設計基礎", None)],
    "case_unmatched_course": [("course_unknown", "未知課程", 80)],
    "case_duplicate_enrollment": [("course_002", "資料庫概念與設計", 79), ("course_002", "資料庫概念與設計", 79)],
}
HEADERS = ["course_id", "course_name", "semester", "grade"]


def generate(output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    font = Path(os.environ.get("FOMOTHON_FONT_PATH", "C:/Windows/Fonts/kaiu.ttf"))
    if not font.is_file():
        raise FileNotFoundError("找不到中文字型，請以 FOMOTHON_FONT_PATH 指定支援中文的 TrueType 字型")
    pdfmetrics.registerFont(TTFont("ChineseFont", str(font)))
    expected = {}
    for student_id, courses in {**STUDENTS, **ANOMALIES}.items():
        rows = [[course_id, name, "114-2", grade] for course_id, name, grade in courses]
        expected[student_id] = [dict(zip(HEADERS, row)) for row in rows]
        (output_dir / f"{student_id}.json").write_text(
            json.dumps(expected[student_id], ensure_ascii=False, indent=2), encoding="utf-8"
        )
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(HEADERS)
        for row in rows:
            sheet.append(row)
        workbook.save(output_dir / f"{student_id}.xlsx")
        workbook.close()
        pdf = canvas.Canvas(str(output_dir / f"{student_id}.pdf"), pagesize=(612, 792))
        pdf.setFont("ChineseFont", 10)
        # 明確分欄，供受限的文字型 PDF 解析器辨識。
        for index, row in enumerate([HEADERS, *rows]):
            pdf.drawString(36, 750 - index * 20, " | ".join("" if value is None else str(value) for value in row))
        pdf.save()
    (output_dir / "expected_enrollments.json").write_text(
        json.dumps(expected, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    generate(Path("data/demo/synthetic_transcripts"))
