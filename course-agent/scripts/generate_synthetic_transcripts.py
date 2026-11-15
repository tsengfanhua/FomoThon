"""由本機課程索引產生課程真實、學分與成績合成的示範成績單。"""

import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from openpyxl import Workbook
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from app.services.course_resolver import resolve_local_course


# 舊版測試相容資料，不參與新版示範成績單產生。
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
HEADERS = ["academic_year", "semester", "course_code", "course_name", "credits", "grade"]


# 課程選擇以實際索引的學期及選課代碼定位，名稱與其他識別欄位均從同一資料列讀取。
DEMO_KEYS = [(114, 2, code) for code in (
    "0772", "1193", "0766", "1332", "0701", "0066", "2061", "1279", "1298", "0051",
    "1817", "2776", "1278", "1264", "1681", "0689", "0721", "0457", "0795", "1503")]
STUDENT_COURSE_INDEXES = {
    "student_demo_001": [0, 1, 6, 7, 8, 2],
    "student_demo_002": [0, 1, 9, 10, 5, 2],
    "student_demo_003": [0, 1, 3, 11, 12, 13],
    "student_demo_004": [0, 1, 4, 14, 15, 16],
    "student_demo_005": [0, 1, 17, 18, 19, 13, 10],
}
DEMO_GRADES = [86, 79, 91, 84, 88, 82, 90]


def select_demo_courses(db_path: Path) -> list[dict]:
    """僅使用唯一且課綱完整的既有資料列，避免自動選擇衝突課程。"""
    courses = []
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        for year, semester, code in DEMO_KEYS:
            rows = conn.execute("SELECT year, semester, selection_code, course_name FROM courses WHERE year=? AND semester=? AND selection_code=?", (year, semester, code)).fetchall()
            if len(rows) != 1 or not isinstance(rows[0][2], str) or not rows[0][2]:
                raise ValueError(f"課程代碼無法唯一辨識：{year}-{semester} {code}")
            actual_year, actual_semester, actual_code, name = rows[0]
            item = {"academic_year": actual_year, "semester": actual_semester, "course_code": actual_code,
                    "course_name": name, "credits": 3.0, "grade": None}
            result = resolve_local_course(db_path, item)
            if result["status"] != "matched":
                raise ValueError(f"課綱不足或無法唯一匹配：{year}-{semester} {code}")
            courses.append(item)
    return courses


def generate(output_dir: Path, db_path: Path = Path("data/processed/course_index.sqlite")) -> None:
    """產生五份課程真實、學分及成績合成的範例及獨立異常案例。"""
    courses = select_demo_courses(db_path)
    cases = {}
    for student, indexes in STUDENT_COURSE_INDEXES.items():
        cases[student] = [{**courses[index], "grade": DEMO_GRADES[position]}
                          for position, index in enumerate(indexes)]
    cases["student_demo_005"][-1]["grade"] = None
    cases["case_missing_grade"] = [{**courses[0], "grade": None}]
    # 故意錯配兩筆真實資料的名稱與代碼，專供無匹配測試。
    cases["case_unmatched_course"] = [{**courses[0], "course_code": courses[1]["course_code"], "grade": 80}]
    cases["case_duplicate_enrollment"] = [{**courses[1], "grade": 79}, {**courses[1], "grade": 79}]
    font = Path(os.environ.get("FOMOTHON_FONT_PATH", "C:/Windows/Fonts/kaiu.ttf"))
    if not font.is_file():
        raise FileNotFoundError("找不到中文字型，請以 FOMOTHON_FONT_PATH 指定支援中文的 TrueType 字型")
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = [output_dir / f"{name}.{ext}" for name in cases for ext in ("json", "xlsx", "pdf")]
    paths.extend([output_dir / "expected_enrollments.json", output_dir / "README.txt"])
    if any(path.exists() for path in paths):
        raise FileExistsError("輸出範例已存在，請選擇新的資料夾以避免覆寫")
    pdfmetrics.registerFont(TTFont("ChineseFont", str(font)))
    for name, records in cases.items():
        (output_dir / f"{name}.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(HEADERS)
        for course in records:
            sheet.append([course[key] for key in HEADERS])
        workbook.save(output_dir / f"{name}.xlsx")
        workbook.close()
        pdf = canvas.Canvas(str(output_dir / f"{name}.pdf"), pagesize=(612, 792))
        pdf.setFont("ChineseFont", 10)
        rows = [HEADERS, *[[course[key] for key in HEADERS] for course in records]]
        for index, row in enumerate(rows):
            pdf.drawString(36, 750 - index * 20, " | ".join("" if value is None else str(value) for value in row))
        pdf.save()
    (output_dir / "expected_enrollments.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "README.txt").write_text("五位學生的課程識別資料來自本機 course_index.sqlite；學分與成績為合成資料，不代表任何真實學生。特殊案例為獨立測試：未匹配案例故意錯配兩筆真實課程的名稱與代碼。\n", encoding="utf-8")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="產生真實課程與合成學分、成績的示範成績單")
    parser.add_argument("--db", type=Path, default=Path("data/processed/course_index.sqlite"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/demo/synthetic_transcripts"))
    args = parser.parse_args()
    generate(args.output_dir, args.db)
