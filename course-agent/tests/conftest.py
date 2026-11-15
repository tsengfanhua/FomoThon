import sqlite3

import pytest

from app.database import INDEX_SCHEMA
from scripts.generate_synthetic_transcripts import DEMO_KEYS


@pytest.fixture
def demo_course_db(tmp_path):
    db = tmp_path / 'demo_courses.sqlite'
    with sqlite3.connect(db) as conn:
        for statement in INDEX_SCHEMA:
            conn.execute(statement)
        for i, (year, semester, code) in enumerate(DEMO_KEYS):
            conn.execute('INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                         (f'c{i}', year, semester, code, f'測試課程{i}', '介紹', '["目標"]', '[{"tpd_learn":"練習"}]'))
    return db
