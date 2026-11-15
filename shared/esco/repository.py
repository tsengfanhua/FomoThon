"""以唯讀方式查詢共用 ESCO 技能目錄。"""

import sqlite3
from contextlib import closing
from pathlib import Path


class EscoRepository:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)

    def _connect(self):
        conn = sqlite3.connect(f"{self.db_path.resolve().as_uri()}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def get(self, concept_uri: str) -> dict | None:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT concept_uri, preferred_label, description FROM esco_skills WHERE concept_uri = ?", (concept_uri,)).fetchone()
            return dict(row) if row else None

    def search(self, query: str, limit: int = 20) -> list[dict]:
        if not query.strip() or not isinstance(limit, int) or limit < 1:
            raise ValueError("搜尋文字不可為空，limit 必須為正整數")
        # 跳脫萬用字元，將輸入視為一般文字。
        pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        with closing(self._connect()) as conn:
            rows = conn.execute("""SELECT concept_uri, preferred_label, description FROM esco_skills
                WHERE preferred_label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
                ORDER BY preferred_label, concept_uri LIMIT ?""", (pattern, pattern, limit)).fetchall()
            return [dict(row) for row in rows]

    def search_ranked(self, query: str, limit: int = 15) -> list[dict]:
        """與 search 相同的文字包含搜尋，但依貼近程度排序。

        順序：名稱完全相同 → 名稱中有完整的詞 → 名稱中有部分字串 → 只在描述中出現；同級時名稱短的在前。
        search 依名稱字母排序後才截斷，命中數多時最貼近的技能可能被截掉；而只看「名稱包含字串」
        會讓 radio 先撈到 radiotherapy，所以完整的詞要排在部分字串之前。
        """
        if not query.strip() or not isinstance(limit, int) or limit < 1:
            raise ValueError("搜尋文字不可為空，limit 必須為正整數")
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        whole_word = f"% {escaped} %"
        with closing(self._connect()) as conn:
            rows = conn.execute("""SELECT concept_uri, preferred_label, description FROM esco_skills
                WHERE preferred_label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
                ORDER BY CASE
                    WHEN lower(preferred_label) = lower(?) THEN 0
                    WHEN ' ' || replace(replace(preferred_label, '(', ' '), ')', ' ') || ' ' LIKE ? ESCAPE '\\' THEN 1
                    WHEN preferred_label LIKE ? ESCAPE '\\' THEN 2
                    ELSE 3 END, length(preferred_label), preferred_label, concept_uri
                LIMIT ?""", (pattern, pattern, query.strip(), whole_word, pattern, limit)).fetchall()
            return [dict(row) for row in rows]
