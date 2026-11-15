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
    if any(str(value).strip().lower() in {"academic_year", "學年", "學年度"} for value in rows[0]):
        return _extract_current(rows)
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


def _extract_current(rows):
    aliases = {"academic_year": {"academic_year", "學年", "學年度"},
               "semester": {"semester", "學期"}, "course_code": {"course_code", "selection_code", "選課代碼"},
               "course_name": {"course_name", "課程名稱", "科目名稱"},
               "credits": {"credits", "學分"}, "grade": {"grade", "成績"}}
    header = [str(value).strip().lower() for value in rows[0]]
    indexes = {field: next((i for i, label in enumerate(header) if label in names), None)
               for field, names in aliases.items()}
    missing = [key for key in ("academic_year", "semester", "course_name") if indexes[key] is None]
    results, warnings = [], []
    if "course_id" in header:
        warnings.append("新版成績單不使用內部 course_id，請確認後移除該欄位")
    if sum(label in aliases["course_code"] for label in header) > 1:
        warnings.append("課程代碼欄位重複，請人工確認")
    for number, row in enumerate(rows[1:], 2):
        if not any(value is not None and str(value).strip() for value in row):
            continue
        item = {key: (row[i] if i is not None and i < len(row) else None) for key, i in indexes.items()}
        item = {key: (value.strip() if isinstance(value, str) else value) for key, value in item.items()}
        item = {key: (None if value == "" else value) for key, value in item.items()}
        for key in ("academic_year", "semester"):
            try:
                item[key] = int(item[key]) if item[key] is not None else None
            except (ValueError, TypeError):
                warnings.append(f"第 {number} 列 {key} 無法辨識")
                item[key] = None
        for key in ("credits", "grade"):
            if item[key] is not None:
                try:
                    import math
                    if isinstance(item[key], bool):
                        raise ValueError
                    value = float(item[key])
                    if not math.isfinite(value) or (key == "grade" and not 0 <= value <= 100) or (key == "credits" and value < 0):
                        raise ValueError
                    item[key] = value
                except (ValueError, TypeError):
                    warnings.append(f"第 {number} 列{'成績須為 0～100 的數值' if key == 'grade' else '學分無法辨識'}，請人工修正")
        if item["course_code"] is not None and not isinstance(item["course_code"], str):
            warnings.append(f"第 {number} 列課程代碼須為文字，請確認前導零")
        results.append(item)
    return results, warnings, missing
