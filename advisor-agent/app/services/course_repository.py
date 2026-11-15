"""讀取本機經處理的課綱資料。"""

import json
from pathlib import Path


class CourseRepository:
    def __init__(self, path: Path):
        self.path = path

    def get(self, course_id: str) -> dict | None:
        with self.path.open(encoding="utf-8") as source:
            courses = json.load(source)
        return next((course for course in courses if course["course_id"] == course_id), None)
