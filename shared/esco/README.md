# 共用 ESCO 技能目錄

在 repository 根目錄，先使用已設定好的 Python 環境執行：

```powershell
python -m shared.esco.init_db --csv course-agent/data/skills_en.csv --db data/shared/esco_skills.sqlite
```

初始化會保留 `conceptUri`、`preferredLabel`、`description` 的英文原文，相同 URI 的資料一致時去重；同一 URI 的內容衝突會中止。重複執行同一份 CSV 不會新增重複資料。初始化會更新同 URI 的名稱與描述，但不會刪除資料庫中已存在、卻不在 CSV 的 URI；更換 ESCO 版本時應先評估既有課程關聯，不要直接覆寫或移除 URI。

共用資料庫的 `esco_skills` 欄位為 `concept_uri`（主鍵）、`preferred_label`、`description`。SQLite 檔案可重建且不納入 Git；原始 CSV 交付於 `course-agent/data/skills_en.csv`，SHA-256 為 `d03b10efca94b4bcfa260a992cfde89c375f0fa12095d6662a663cfd2f9f2950`。來源資料的 ESCO 版本尚未確認；若重新從官方下載，不能假定與此檔版本或內容相同。

This service uses the [ESCO classification](https://esco.ec.europa.eu/) of the European Commission. 共用資料庫只選取原始 CSV 的三個欄位，屬於所需資料子集；ESCO 使用及重用條件見[官方說明](https://esco.ec.europa.eu/en/about-esco/faq)。

## 唯讀查詢

其他 Agent 可將 repository 根目錄加入 Python 的模組搜尋路徑，並以明確路徑建立 Repository：

```python
from pathlib import Path
from shared.esco.repository import EscoRepository

repo = EscoRepository(Path("data/shared/esco_skills.sqlite"))
skill = repo.get("http://data.europa.eu/esco/skill/example")  # 不存在時為 None
matches = repo.search("data analysis", limit=20)
```

回傳欄位為 `concept_uri`、`preferred_label`、`description`。`search` 對名稱或描述做文字包含搜尋；SQLite 內建 LIKE 的大小寫處理主要適用 ASCII，這不是語意檢索。查詢使用唯讀 SQLite 連線，資料庫不存在時不會建立空檔案。

Course Agent 寫入 `course_skills` 時必須使用 `app.database.save_course_skill`；SQLite 無法建立跨資料庫外鍵，直接使用 SQL 寫入會繞過 URI 檢查。若共用資料庫的 URI 集合變動，應重新核對既有關聯。
