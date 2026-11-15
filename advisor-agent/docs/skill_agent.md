# Skill Analysis Agent 技術文件

本文件描述 `feature/skill-agent` 工作目錄中目前的實作。共用契約及與其他 Agent 的整合仍待團隊確認。修課技能評分是實驗性證據支持度，不是學生技能熟練度或已驗證的能力測量。

## 1. 目的與責任

Skill Analysis Agent 將成績單轉為待確認修課紀錄，匹配課程描述，萃取技能候選並彙整 Profile；可選擇計算修課證據 sidecar。呼叫端負責學生確認、確保資料屬於同一位學生及確認課程文字可對外傳送。本 Agent 不實作登入、使用者身分、前端、跨 Agent Orchestrator 或學生資料永久儲存。

## 2. 資料流程

```text
PDF／XLSX → parse → 待學生確認的 enrollments
                              ↓ analyze
SQLite 課程匹配 → 每門匹配課程 LLM 萃取 Skill / Knowledge / Topic
                              ↓
Skill 彙整 → Student Skill Profile + 證據細節
                              ↓ 選用
課程原文 + 已確認成績 → Course-based Skill Evidence Scoring sidecar
```

只有成功萃取的 Skill 進入技能彙整；Knowledge／Topic 保留在 `courses`，不變成技能。未匹配課程不呼叫 LLM。各課程狀態可共存；`completed` 不代表技能或證據經人工確認。

## 3. 模組與職責

| 檔案 | 職責 |
|---|---|
| `app/main.py`、`app/api/skills.py` | FastAPI、路由、HTTP 錯誤處理與依賴注入。 |
| `app/schemas/skill_api.py`、`app/schemas/skills.py` | API 輸入與共用 Skill／Enrollment／Profile 契約。 |
| `app/services/document_parser.py`、`enrollment_extractor.py` | 解析文件表格及提取待確認紀錄。 |
| `app/services/course_matching.py` | 從 SQLite 唯讀匹配修課紀錄。 |
| `app/services/llm_client.py`、`skill_extraction.py` | 模型呼叫介面、單課程候選、格式及原文檢查。 |
| `app/services/skill_profile.py` | 技能映射、去重、跨課程彙整與狀態。 |
| `app/services/course_evidence_scoring.py` | 獨立的確定性修課證據評分。 |
| `app/services/skill_analysis.py` | 串接匹配、萃取、彙整與可選評分。 |

## 4. 解析與匹配

`parse_document` 支援 XLSX 第一張工作表，及以 `|` 分欄的文字型 PDF；掃描影像、加密 PDF 或其他 PDF 排版不支援。`extract_enrollments` 根據明確標題辨識課程、學期及成績；無法解析的成績轉為 null 並提出警告，不推測缺值。回傳待確認紀錄；重複與未知課程不由解析階段刪除。

匹配時優先以 `course_id` 查詢，否則以課名及學期完全匹配；須檢查學期一致。兩個方法匹配到相同課程及學期的重複紀錄均標記 `duplicate`，不選擇其中一筆。可能狀態包含 `matched`、`not_found`、`ambiguous`、`duplicate`、`semester_mismatch`、`insufficient_data`、`invalid_input`。課程資料庫使用唯讀模式，路徑錯誤不自動建立。

## 5. LLM 抽取與驗證

每個匹配課程的 LLM 輸入僅包含課程 ID、課名、學期及課程描述；不包含成績單原檔或成績。服務請模型輸出 `skills`、`knowledge`、`topics`，各項包含原文引文與理由；Skill 額外有 `evidence_basis`：`explicit_activity`、`learning_objective`、`course_scope`。

程式以 Pydantic 檢查格式與分類，並要求所有引文逐字存在於輸入課程描述。格式錯誤或引文不存在時最多再試一次；兩次未通過回傳 `needs_review`。模型呼叫例外回傳 `failed`／`llm_api_error`，不輸出例外原文。無技能時可回傳 `insufficient_evidence`。字串檢查不能證明技能分類、模型理由或語意正確；所有證據仍為 `pending`。課程描述可能是摘錄，不等於完整課綱。

## 6. 跨課程彙整

`build_skill_profile` 僅使用 `completed` 的 Skill；同課程 ID 與學期的完全相同結果去重，衝突結果不選取並要求確認。相同技能、課程、學期及逐字引文去重，詳細資料保留原名稱、理由及分類。共用 `SkillEvidence` 不含學期，需連同 `evidence_details` 使用。

技能名稱以 Unicode NFKC、空白整理及 casefold 比對 `data/seed/skills.json` 和 `data/seed/skill_aliases.json`。明確名稱或別名匹配為 `mapped`；否則以正規化名稱的 SHA-256 產生 `candidate_v1_...` 暫定 ID，為 `unmapped`。不做模糊或語意合併。新增或變更別名可能改變映射，持久化及跨 Agent 串接需規劃 ID 對照／遷移。Profile 的技能 `confirmed=false`，證據 `pending`。

## 7. Course-based Skill Evidence Scoring v0.2

此功能預設停用，結果以 `score_type=course_skill_evidence`、`scoring_version=course_evidence_v0.2` 的 sidecar 回傳。共用五維 Profile 仍維持原本的 `score=null`、五維未評估，不將兩維分數寫入共用 `score`。

- `quote_in_source` 嚴格檢查逐字引文；無來源或來源衝突為 null。`support_match` 只辨識技能名稱逐字存在（`exact`），或名稱中插入一次「的」（`inserted_de`）；否定詞或其他情況為 `needs_review`。這是文字規則而非語意驗證，可能誤擋或誤收，仍須人工審查。
- 舊 `source_verified` 保留 v0.1 的複合語意（引文存在且技能名稱逐字出現），不能單獨視為引文存在檢查；新串接分別使用 `quote_in_source` 與 `support_match`。
- 引文及文字條件通過後依模型分類暫定課程關聯分數：`explicit_activity` 60、`learning_objective` 40、`course_scope` 20。同一引文不同分類取較低值；同課程合格引文取最高值。模型分類、數值及權重皆未經實證驗證。
- 數字成績僅在呼叫端明確指定 `0_100` 時使用；缺失、無法轉換、制度未知或同課程成績衝突時為 null。底層 service 可由呼叫端提供等第對照，但目前 API Enrollment 只接受數字或 null，不接受等第。
- 兩維都有值時：`課程分數 = round(0.6 × 課程關聯 + 0.4 × 課程成績, 2)`；任一維不可評估時課程總分為 null。跨課程取完整單課程分數的最大值，不相加，也不把不同課程的維度拼成完整分數。各課程、引文及 `coverage`、`complete_course_count`、`course_count` 保留。

## 8. FastAPI 啟動與範例

建立示範課程資料庫（seed 的課程描述為待審查摘錄，僅供本機展示）：

```powershell
.\.venv\Scripts\python.exe -m scripts.init_course_db --seed data/seed/courses.json --db data/processed/shared_course_demo.sqlite --allow-unreviewed-demo
```

在專案 `.env` 或程序環境設定 `OPENAI_API_KEY`、`SKILL_LLM_MODEL`，可設定 `SKILL_DB_PATH`；程序環境變數優先，未設定 DB 路徑則使用 `data/processed/shared_course_demo.sqlite`。不要提交 `.env` 或輸出金鑰。啟動：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Swagger UI 為 `http://127.0.0.1:8000/docs`，OpenAPI 為 `/openapi.json`。真實分析可能計費；課程 ID、課名、學期和描述會送至外部 LLM，須先確認資料分享權限。

### 解析成績單

`POST /api/v1/skills/parse` 接收 `multipart/form-data`，檔案欄位為 `file`：

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/v1/skills/parse -F "file=@data/demo/synthetic_transcripts/case_duplicate_enrollment.xlsx"
```

回應範例（虛構，數值與內容依文件而變）：

```json
{"status":"needs_confirmation","enrollments":[{"course_id":"course_001","course_name":"合成課程","semester":"114-2","grade":85.0}],"warnings":[],"missing_fields":[]}
```

### 分析已確認課程

`POST /api/v1/skills/analyze` 請求範例：

```json
{"enrollments":[{"course_id":"course_001","semester":"114-2","grade":85}],"scoring":{"enabled":true,"numeric_scale":"0_100"}}
```

`scoring` 可省略，預設停用。呼叫端需確認成績制度；學生姓名、學號等額外輸入欄位會被拒絕。以下為**回應結構節錄示意**，並非完整 JSON Schema；技能與評分內容會因模型及資料而異：

```json
{
  "status": "completed",
  "profile": {"skills": [{"skill_id": "sql", "skill_name": "SQL", "score": null, "confirmed": false}]},
  "evidence_details": [],
  "skill_mappings": [{"skill_id": "sql", "skill_name": "SQL", "mapping_status": "mapped"}],
  "courses": [],
  "issues": [],
  "course_statuses": [{"index": 0, "match_status": "matched", "match_method": "course_id", "course_id": "course_001", "semester": "114-2", "analysis_status": "completed", "error_reason": null}],
  "scoring": {"score_type": "course_skill_evidence", "scoring_version": "course_evidence_v0.2", "skills": [{"skill_id": "sql", "score": 55.6}]}
}
```

實際 `profile` 包含共用 Schema 的完整欄位、原始證據與五維狀態；實際 `scoring` 另含權重、成績制度及逐課程依據。詳細欄位以程式輸出及 Swagger 為準。

## 9. 狀態、錯誤與整合資訊

`parse` 成功回 `needs_confirmation`；副檔名不支援為 HTTP 415，解析失敗或輸入驗證失敗為 422。`analyze` 的 `status` 為 `completed`、`partial`、`needs_confirmation` 或 `failed`；`needs_confirmation` 在相關狀態存在時優先。`profile.analysis_status` 為 `complete`、`partial` 或 `insufficient_data`，Profile 不可用時為 null。

`course_statuses` 依輸入索引提供 `match_status`、`match_method`、`analysis_status`、`error_reason`；`issues` 彙整原因。部分課程失敗也可能回 HTTP 200，不能只看 HTTP 狀態。SQLite 不可用回 503；LLM 的通用錯誤為 `llm_api_error`，client 初始化或其他萃取例外可為 `analysis_unavailable`。`needs_review` 的原因可能是 `invalid_llm_output` 或 `evidence_not_in_source`。

API 目前沒有 `run_id`、`trace_events`、階段時間或 LLM `attempts` 輸出；雖然核心 `ExtractionResult` 有嘗試次數，分析回應沒有帶出。`scoring=null` 在正常回應表示評分停用；啟用但無技能可能回空 `skills`。未來 Orchestrator 應統一處理跨 Agent run ID、事件格式、呼叫時間與跨 Agent 重試；逐課程結果、錯誤碼和可能的評分跳過原因需協議如何由 Agent 提供。不要假設現有回應已能還原完整執行事件。

## 10. 測試與限制

```powershell
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider --basetemp .pytest_tmp
```

最近一次完整測試結果為 87 passed；TestClient 整合測試使用 Mock LLM，不證明真實模型輸出品質或外部服務穩定性。一次使用者操作的真實 API 測試顯示匹配及三項候選可輸出，兩項依 v0.2 規則得分、另一項需審查；不是代表性評估。

目前不支援掃描型成績單、等第 API 輸入、自動確認、五維完整評分、Trace 系統或學生資料持久化。真實課程文字授權、模型分類正確性、技能別名及評分規則均待團隊確認。候選技能的文字證據可以被保留與回溯，不等於學生實際已掌握技能。
