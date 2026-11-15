"""替整合網站的示意學生各配一份由真實課程組成的修課清單（人是合成的、課是真的）。

助理流程改用真實資料時，「能力盤點」與「找隊友」需要學生的修課才能對應到 ESCO 技能；
平台上的示意學生原本只有合成課程，所以依各人的科系挑選已分析過的真實課程，
輸出 data/shared/campus_enrollments.json 供網站讀取。只有課程識別資料，沒有成績。

課程以課名指定，選課代碼由課程資料庫查出；找不到或尚未分析的課會直接報錯，不會默默略過。
在 repository 根目錄執行：python scripts/build_campus_personas.py
"""

import argparse
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
YEAR, SEMESTER = 114, 2

# 示意學生（fomothon/data/seed/people.json）→ 依科系與人物設定挑的課
PERSONA_COURSES = {
    "S01": ["Python程式設計與應用", "資料結構", "資料庫設計", "人工智慧概論", "程式設計與問題解決", "機率與統計"],       # 資工二，想試 AI 黑客松
    "S05": ["機器學習", "人工智慧自然語言導論", "資料庫系統", "Web程式設計", "數位影像處理", "人工智慧專題實務"],    # 資工三
    "S12": ["機器學習", "人工智慧與大數據", "系統分析與設計", "電子商務安全", "網際網路應用程式設計", "多媒體系統", "人工智慧應用"],  # 資工四
    "S14": ["程式設計與問題解決", "資料結構實習", "資料結構", "Web程式設計", "資料庫設計", "Python程式設計"],          # 資工二
    "S90": ["Python入門", "人工智慧入門與省思"],                                                                      # 測試帳號
    "S02": ["視覺溝通設計專題", "互動設計與參與式行銷", "品牌設計與行銷企劃", "設計表現法", "設計倫理", "iOS APP程式設計"],  # 設計三，喜歡做 App 介面
    "S06": ["設計表現法", "視覺與家具設計", "室內設計(二)", "展演空間設計", "影像創作與視覺行銷", "圖文動態編輯與行銷溝通"],  # 設計二
    "S03": ["多媒體應用", "遊戲與創意的跨域探索", "3D動畫實作與歷史建物永續II", "提示語工程與AI數位創作", "音樂原理與數位創作", "區塊鏈原理與數位藝術"],  # 數媒二
    "S04": ["系統分析與設計", "電子商務", "互動設計與參與式行銷", "Web程式設計", "用戶行為分析及行銷決策", "資料處理與大數據分析"],  # 資管三
    "S08": ["Python程式設計", "電子商務", "基礎程式設計(二)", "資料科學商管應用", "管理學", "統計學(一)"],                # 資管二
    "S15": ["大數據分析", "資料庫系統", "電子商務安全", "數位行銷", "資料科學實務應用", "管理與統計"],                    # 資管三
    "S07": ["英文作文(四)", "英文句構與翻譯(二)", "英文演講", "商業英文簡報", "AI與機器翻譯", "國際事務英文"],            # 外文三
    "S09": ["行銷管理", "行銷策略與個案分析", "數位行銷策略與工具", "管理學", "服務行銷", "品牌設計與行銷企劃"],          # 企管三
    "S11": ["管理學", "行銷研究與田野調查", "數位行銷專題實作", "國際行銷管理", "商用英文會話(二)", "財務管理"],          # 企管二
    "S10": ["財務報表分析", "投資學", "國際財務管理", "金融大數據與投資分析", "投資組合分析", "永續金融與投資"],          # 財金三
    "S13": ["統計計算", "迴歸分析", "機率論", "資料科學實務應用", "統計套裝軟體(一)", "計算統計與數據分析導論"],          # 統計三
}


def analyzed_courses(course_db: Path) -> dict[str, str]:
    """已分析且有技能的課：課名 → 選課代碼（同名多班時取代碼最小的那一班）。"""
    with closing(sqlite3.connect(f"{course_db.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        rows = conn.execute("""SELECT trim(c.course_name), min(c.selection_code) FROM courses c
            WHERE c.year=? AND c.semester=? AND EXISTS (SELECT 1 FROM course_skills s WHERE s.course_id=c.course_id)
            GROUP BY trim(c.course_name)""", (YEAR, SEMESTER)).fetchall()
    return dict(rows)


def build(course_db: Path) -> dict:
    codes = analyzed_courses(course_db)
    missing = sorted({name for names in PERSONA_COURSES.values() for name in names if name not in codes})
    if missing:
        raise SystemExit(f"以下課程在 {YEAR}-{SEMESTER} 找不到或尚未分析：{'、'.join(missing)}")
    return {
        "_meta": {"note": "示意學生的修課清單：學生是合成的，課程是真實開課資料；只有課程識別欄位，沒有成績。",
                  "academic_year": YEAR, "semester": SEMESTER, "generated_by": "scripts/build_campus_personas.py"},
        "students": {student: [{"academic_year": YEAR, "semester": SEMESTER, "course_code": codes[name], "course_name": name}
                               for name in names] for student, names in PERSONA_COURSES.items()},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="產生示意學生的真實課程修課清單")
    parser.add_argument("--course-db", type=Path, default=ROOT / "course-agent/data/processed/course_index.sqlite")
    parser.add_argument("--out", type=Path, default=ROOT / "data/shared/campus_enrollments.json")
    args = parser.parse_args()
    payload = build(args.course_db)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps({"students": len(payload["students"]),
                                 "enrollments": sum(len(v) for v in payload["students"].values()), "out": str(args.out.name)},
                                ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
