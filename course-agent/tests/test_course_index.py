"""新版課綱及 ESCO 索引的匯入與查詢測試。"""
import csv
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from app.database import find_indexed_courses, import_course_index, save_course_skill

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.esco.init_db import initialize_esco
from shared.esco.repository import EscoRepository


class CourseIndexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / "index.sqlite"
        self.esco_db = self.root / "esco.sqlite"
        for term in ("113-1", "113-2", "114-1", "114-2"):
            (self.root / term).mkdir()
            year, semester = map(int, term.split("-"))
            data = {"info": {"yms_year": year, "yms_smester": semester,
                             "scr_selcode": "0001", "sub_name": "課程"},
                    "description": {"describe_ch": "原文", "ignored": "不可匯入"},
                    "targets": [{"describe_ch": "目標"}],
                    "weeklyScds": [{"tpd_reading": "閱讀", "tpd_learn": "學習", "ignored": "不可匯入"}]}
            (self.root / term / "course.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        with (self.root / "skills_en.csv").open("w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["conceptUri", "preferredLabel", "description", "ignored"])
            writer.writerows([["uri:1", "Skill", "English description", "not imported"]] * 2)
        initialize_esco(self.root / "skills_en.csv", self.esco_db)

    def test_import_lookup_idempotence_and_foreign_keys(self):
        result = import_course_index(self.db, self.root, self.esco_db)
        self.assertEqual(result["courses"], 4)
        self.assertEqual(initialize_esco(self.root / "skills_en.csv", self.esco_db)["unique_skills"], 1)
        import_course_index(self.db, self.root, self.esco_db)
        course = find_indexed_courses(self.db, 113, 1, "0001")[0]
        self.assertEqual(course["description"], "原文")
        self.assertEqual(course["targets"], ["目標"])
        self.assertEqual(course["weekly_schedule"], [{"tpd_reading": "閱讀", "tpd_learn": "學習"}])
        self.assertEqual(find_indexed_courses(self.db, 113, 1, "1"), [])
        with closing(sqlite3.connect(self.db)) as conn:
            conn.execute("PRAGMA foreign_keys=ON")
            self.assertEqual(conn.execute("SELECT count(*) FROM courses").fetchone()[0], 4)
            self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name='esco_skills'").fetchone())
            self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        repo = EscoRepository(self.esco_db)
        self.assertEqual(repo.get("uri:1")["preferred_label"], "Skill")
        self.assertIsNone(repo.get("unknown"))
        self.assertEqual(repo.search("description")[0]["concept_uri"], "uri:1")
        self.assertEqual(repo.search("%"), [])
        with self.assertRaisesRegex(ValueError, "不存在"):
            save_course_skill(self.db, self.esco_db, course["course_id"], "unknown", "description", "原文")
        save_course_skill(self.db, self.esco_db, course["course_id"], "uri:1", "description", "原文")
        with self.assertRaises(sqlite3.IntegrityError):
            save_course_skill(self.db, self.esco_db, "unknown", "uri:1", "description", "原文")
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute("SELECT concept_uri, evidence FROM course_skills").fetchall(), [("uri:1", "原文")])

    def test_ambiguous_code_keeps_both_courses(self):
        path = self.root / "113-1" / "course.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["info"]["sub_name"] = "另一門課"
        (path.parent / "second.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        import_course_index(self.db, self.root, self.esco_db)
        matches = find_indexed_courses(self.db, 113, 1, "0001")
        self.assertEqual(len(matches), 2)
        self.assertEqual(len({course["course_id"] for course in matches}), 2)

    def test_import_mixed_standard_and_suffixed_directories(self):
        for term in ("113-1", "114-2"):
            (self.root / term).rename(self.root / f"{term}教學大綱")
        result = import_course_index(self.db, self.root, self.esco_db)
        self.assertEqual(result["source_courses"], {term: 1 for term in ("113-1", "113-2", "114-1", "114-2")})
        self.assertEqual(len(find_indexed_courses(self.db, 113, 1, "0001")), 1)
        self.assertEqual(len(find_indexed_courses(self.db, 114, 2, "0001")), 1)

    def test_both_directory_names_rejected_without_database_change(self):
        import_course_index(self.db, self.root, self.esco_db)
        (self.root / "113-1教學大綱").mkdir()
        with self.assertRaisesRegex(ValueError, "同一學期存在兩個課綱目錄"):
            import_course_index(self.db, self.root, self.esco_db)
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM courses").fetchone()[0], 4)

    def test_conflicting_skill_does_not_change_database(self):
        import_course_index(self.db, self.root, self.esco_db)
        with (self.root / "skills_en.csv").open("a", encoding="utf-8", newline="") as f:
            csv.writer(f).writerow(["uri:1", "different", "English description", ""])
        with self.assertRaisesRegex(ValueError, "衝突"):
            initialize_esco(self.root / "skills_en.csv", self.esco_db)
        with closing(sqlite3.connect(self.esco_db)) as conn:
            self.assertEqual(conn.execute("SELECT preferred_label FROM esco_skills").fetchone()[0], "Skill")

    def test_migration_preserves_links_and_rejects_mismatch(self):
        import_course_index(self.db, self.root, self.esco_db)
        course_id = find_indexed_courses(self.db, 113, 1, "0001")[0]["course_id"]
        with closing(sqlite3.connect(self.db)) as conn, conn:
            conn.execute("DROP TABLE course_skills")
            conn.execute("CREATE TABLE esco_skills (concept_uri TEXT PRIMARY KEY, preferred_label TEXT NOT NULL, description TEXT NOT NULL)")
            conn.execute("INSERT INTO esco_skills VALUES ('uri:1', 'different', 'English description')")
            conn.execute("CREATE TABLE course_skills (course_id TEXT REFERENCES courses(course_id), concept_uri TEXT REFERENCES esco_skills(concept_uri), source_section TEXT, evidence TEXT, PRIMARY KEY(course_id, concept_uri, source_section, evidence))")
            conn.execute("INSERT INTO course_skills VALUES (?, 'uri:1', 'description', '原文')", (course_id,))
        with self.assertRaisesRegex(ValueError, "不一致"):
            import_course_index(self.db, self.root, self.esco_db)
        with closing(sqlite3.connect(self.db)) as conn, conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM esco_skills").fetchone()[0], 1)
            conn.execute("UPDATE esco_skills SET preferred_label='Skill'")
        import_course_index(self.db, self.root, self.esco_db)
        with closing(sqlite3.connect(self.db)) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM course_skills").fetchone()[0], 1)
            self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name='esco_skills'").fetchone())
            self.assertEqual([row[2] for row in conn.execute("PRAGMA foreign_key_list(course_skills)")], ["courses"])


if __name__ == "__main__":
    unittest.main()
