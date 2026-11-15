# Skill 資料契約 v0.1 draft

本文件與 `app/schemas/skills.py` 是供團隊審查的契約草案，不表示其他 Agent 已採用。所有課綱來源僅涵蓋 114-2；課程教授內容不等於學生實際能力。 `Enrollment` 代表已修過的課程；文件抽取與待確認欄位不在此階段實作。

## 共用欄位

| 模型 | 主要欄位 | 說明 |
|---|---|---|
| Skill | `skill_id`, `skill_name`, `category` | `skill_id` 為穩定的內部標籤，分類供整理，不代表能力評測。 |
| Course | `course_id`, `course_name`, `semester`, `credits`, `syllabus_text` | 本機 seed 保留原始課名與「課程描述」原文摘錄；`syllabus_text` 不是整份課綱，不可預設對外公開。 |
| Enrollment | `course_id`, `course_name`, `semester`, `grade` | `course_name`、百分制 `grade` 可為 null；無法轉換的成績須先人工處理。 |
| SkillEvidence | `course_id`, `skill_id`, `source_type`, `source_section`, `relevance`, `evidence_reference`, `review_status` | `relevance` 可為 null；`pending` 與 `rejected` 均不是已確認證據。`evidence_reference` 是待審查的改寫摘要，非原文或安全公開保證。 |
| StudentSkill | `skill_id`, `skill_name`, `score`, `score_type`, `scoring_version`, `evidence`, `confirmed`, `dimension_scores`, `missing_dimensions` | `score` 是完整五維推估分數，非課程支持度；缺任一維度時必須是 null。`confirmed` 指學生確認，與課程證據審查不同。 |
| StudentSkillProfile | `student_id`（可省略或為 null）, `skills`, `scoring_version`, `analysis_status` | 不負責身分管理，關聯學生由整合系統處理。狀態為 `complete`、`partial` 或 `insufficient_data`；實際產生與狀態判定尚未實作。 |

Course Support 是課綱關聯維度可考慮的方法，尚未實作或取得對完整計算規則的確認。不得把課程支持度當成學生實際能力，也不得使用待審查關聯作為已確認的輸出證據。

### 五維語意

| 維度欄位 | 權重 | 目前狀態 |
|---|---:|---|
| `syllabus_relevance` | 0.4 | 課程內容與技能的關聯；待人工審查。 |
| `course_grade` | 0.2 | 相關修課成績；欠缺時不得假定為零。 |
| `practice_project` | 0.2 | 實作／專題比重；尚無已確認的量化規則。 |
| `portfolio_certification` | 0.1 | 作品／證照佐證；尚無已確認的計分規則。 |
| `recency` | 0.1 | 修課時間；尚無有效的比較與計分規則。 |

每個維度都有 `weight`、`score` 與 `status`。`evaluated` 需要有效分數；`missing`、`not_evaluated` 必須為 null。`missing_dimensions` 列出兩種未評估狀態的所有維度；沒有公式會在此資料層自動計算成績或總分。

### Student Skill Profile 例子

以下為完全虛構的結構範例，不代表分析結果。`student_id` 可省略：

```json
{
  "scoring_version": "draft",
  "analysis_status": "insufficient_data",
  "skills": [{
    "skill_id": "python",
    "skill_name": "Python",
    "score": null,
    "score_type": "five_dimension_estimate",
    "scoring_version": "draft",
    "confirmed": false,
    "evidence": [],
    "dimension_scores": {
      "syllabus_relevance": {"weight": 0.4, "score": null, "status": "not_evaluated"},
      "course_grade": {"weight": 0.2, "score": null, "status": "not_evaluated"},
      "practice_project": {"weight": 0.2, "score": null, "status": "not_evaluated"},
      "portfolio_certification": {"weight": 0.1, "score": null, "status": "missing"},
      "recency": {"weight": 0.1, "score": null, "status": "not_evaluated"}
    },
    "missing_dimensions": ["syllabus_relevance", "course_grade", "practice_project", "portfolio_certification", "recency"]
  }]
}
```

## Skill Taxonomy 初版

| Category | 穩定 skill_id（顯示名稱） |
|---|---|
| programming | `programming`（程式設計）、`python`（Python）、`data_structures`（資料結構）、`algorithms`（演算法）、`network_programming`（網路程式設計） |
| database | `sql`（SQL）、`database_design`（資料庫設計） |
| data | `statistics`（統計學）、`data_analysis`（資料分析）、`data_visualization`（資料視覺化） |
| ai | `artificial_intelligence`（人工智慧）、`machine_learning`（機器學習） |
| design | `image_processing`（影像處理）、`visual_design`（視覺設計） |
| security | `information_security`（資訊安全） |
| management | `project_management`（專案管理） |

可機器讀取的分類清單位於 `data/seed/skills.json`；`skill_name` 使用繁體中文，Python、SQL 等技術名稱保留英文，`skill_id` 與 `category` 保留穩定英文代碼。同一技能跨課程使用同一 ID；不同粒度如人工智慧／機器學習與程式設計／Python 暫時分列，並非同義詞。分類和關聯仍需人工審查，未來合併同義詞或改名需與下游協調並規劃 ID 相容性。

## SQLite 與初始化

- `courses`：內部 ID、課名、學期、學分、課綱、課程審查狀態與文字來源類型。
- 目前共用的初始化腳本只建立 `courses`，不建立學生、修課、技能或課程技能關聯表。
- 舊版 `initialize_database` 與測試仍使用 `skills`、`course_skills`，暫時保留避免刪除既有成果；共用的 `initialize_course_database` 和 CLI 不依賴它們。初始化既有資料庫時不會移除舊表。

`data/seed/courses.json` 是供團隊審查的共用 Seed 候選，依專案負責人說明，課程來源可在網上公開取得。它包含原課名及課程描述，標示 `original_excerpt`：僅擷取「課程描述」段落並去除段首尾空白，不是完整課綱。直接識別資訊已檢查，但原文仍可能被反查；資料分享權限及重新識別風險尚未獨立驗證，請在 PR 審查時確認。共用 Seed 僅含課程，課程狀態為 `pending`；先前的技能與關聯仍保留在被忽略的本機研究草稿，僅供舊流程使用。

原始 Excel、本機草稿 `data/processed/course_seed_draft.json`、原始 ID 對照及 SQLite 檔案仍由 Git 忽略，不應提交。展示成績單的課名是虛構替代名稱，只依內部 ID 對應。

從已人工審查的 seed 建立資料庫（不需讀 Excel）：

```powershell
.\.venv\Scripts\python.exe -m scripts.init_course_db --seed data/processed/course_seed_reviewed.json --db data/processed/courses.sqlite
```

目前共用 Seed 的課程與技能關聯尚待人工審查；為本機測試可明確執行：

```powershell
.\.venv\Scripts\python.exe -m scripts.init_course_db --seed data/seed/courses.json --db data/processed/shared_course_demo.sqlite --allow-unreviewed-demo
```

旗標不會改變審查狀態，不得把資料庫中的待審資料視為已確認證據。程式只能讀取人工填入的狀態，無法驗證是誰審查、審查是否充分或是否具有授權。初始化以主鍵 upsert，重複執行不會增加相同資料；它不會刪除已不在 seed 中的舊資料，也不會自動遷移舊版表格結構，因此不是完整同步或遷移工具。測試包含完全合成學生的課程 ID，驗證共用 Seed 不依賴原始 Excel 也可初始化與對應。
