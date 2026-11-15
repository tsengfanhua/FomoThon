# 已確認修課紀錄的課程匹配

`match_enrollments(db_path, enrollments)` 接受 SQLite 路徑與 JSON 陣列字串或已解析的 list，回傳依輸入順序排列的結果。輸入欄位沿用 `Enrollment`；缺少 `course_id` 時允許使用課名與學期查詢，匹配後的課程符合共用 `Course`。每筆紀錄仍須提供學期，成績可省略或為 null。

```python
from pathlib import Path
from app.services.course_matching import match_enrollments

results = match_enrollments(Path("data/processed/shared_course_demo.sqlite"), [
    {"course_id": "course_001", "semester": "114-2", "grade": 85},
    {"course_name": "資料庫設計", "semester": "114-2"},
])
```

結果範例（課程描述內容僅示意）：

```json
{
  "index": 0,
  "status": "matched",
  "match_method": "course_id",
  "course": {
    "course_id": "course_001",
    "course_name": "Python程式設計",
    "semester": "114-2",
    "credits": 2.0,
    "syllabus_text": "課程描述摘錄……"
  }
}
```

- 有 ID 時只查 ID，不用名稱回退；學期必須一致。名稱可為成績單上的替代名稱，不用於驗證 ID。
- 無 ID 時，課名與學期去除前後空白後須精確吻合；不做模糊匹配。
- `status`：`matched` 成功；`not_found` 找不到；`ambiguous` 名稱及學期對應多筆；`insufficient_data` 缺少必要資料；`semester_mismatch` ID 存在但學期不符；`invalid_input` 不符合輸入契約；`duplicate` 同一 ID 與學期重複出現。不同匹配方式指向同一課程也視為重複，所有重複紀錄均不回傳課程。
- `match_method` 為 `course_id`、`course_name_semester` 或未查詢時的 null；失敗時 `course` 為 null。無效 JSON、非陣列與資料庫錯誤會拋出例外。
- 目前共用 Seed 的 `syllabus_text` 是課程描述原文摘錄，不是完整課綱，課程資料審查狀態仍為 pending；匹配成功不代表內容已審查或可公開，也不代表學生具備任何技能。
