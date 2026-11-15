"""將明確標題的成績單表格轉成待人工確認的欄位。"""

ALIASES = {
    "course_id": {"course_id", "課程代碼", "課號"},
    "course_name": {"course_name", "課程名稱", "科目名稱"},
    "semester": {"semester", "修課學期", "學期"},
    "grade": {"grade", "成績", "分數"},
}


def extract_enrollments(rows: list[list[str]]) -> tuple[list[dict], list[str], list[str]]:
    """回傳候選紀錄、警告與無法辨識欄位；不推測遺漏的值。"""
    if not rows:
        return [], ["沒有讀取到表格"], ["course_id", "course_name", "semester", "grade"]
    header = [str(value).strip().lower() for value in rows[0]]
    indexes = {field: next((i for i, label in enumerate(header) if label in names), None)
               for field, names in ALIASES.items()}
    missing = [field for field, index in indexes.items() if index is None]
    warnings = []
    if indexes["course_id"] is None and indexes["course_name"] is None:
        warnings.append("無法辨識課程欄位，請人工輸入或修正")
        return [], warnings, missing
    enrollments = []
    for row_number, row in enumerate(rows[1:], start=2):
        if not any(str(value).strip() for value in row):
            continue
        item = {field: (str(row[index]).strip() if index is not None and index < len(row) else "")
                for field, index in indexes.items()}
        if not item["course_id"] and not item["course_name"]:
            warnings.append(f"第 {row_number} 列缺少課程識別資料")
            continue
        grade = item["grade"]
        if grade:
            try:
                number = float(grade)
                if not 0 <= number <= 100:
                    raise ValueError
                item["grade"] = number
            except ValueError:
                item["grade"] = None
                warnings.append(f"第 {row_number} 列成績無法辨識，請人工確認")
        else:
            item["grade"] = None
        enrollments.append({key: value or None if key != "grade" else value for key, value in item.items()})
    return enrollments, warnings, missing
