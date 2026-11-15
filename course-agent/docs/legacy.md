# Legacy HTTP API 相容說明

此頁供既有呼叫端使用，**不是正式跨 Agent 契約**。正式整合採 [MCP 與 ESCO](integration_guide.md)。由於無法確認所有舊呼叫端，舊實作與測試暫時保留；移除前需先確認遷移。

## 啟動與 API

在 `course-agent` 目錄，先依 [整合指南](integration_guide.md) 安裝依賴，再使用舊 seed 建立獨立資料庫：

```powershell
..\.venv\Scripts\python.exe -m scripts.init_course_db --seed data/seed/courses.json --db data/processed/shared_course_demo.sqlite --allow-unreviewed-demo
$env:SKILL_DB_PATH = 'data/processed/shared_course_demo.sqlite'
$env:SKILL_LLM_MODEL = '<模型名稱>'
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

使用前須安全設定 `OPENAI_API_KEY` 並確認課程文字分享權限；呼叫可能計費。Swagger 在 `/docs`。舊資料庫與正式 MCP 的 Course SQLite 使用不同結構，不可混用。

- `POST /api/v1/skills/parse` 接收 `multipart/form-data` 的 `file`（PDF 或 XLSX），回傳 `needs_confirmation`、`enrollments`、`warnings`、`missing_fields`；呼叫端須人工確認。
- `POST /api/v1/skills/analyze` 接收 `enrollments` 與可選 `scoring`。舊輸入可用 `course_id` 和 `semester`，或課名和學期；`grade` 為 0–100 或 null。多餘欄位被拒絕。資料庫不可用為 503，格式錯誤為 422。

```json
{"enrollments":[{"course_id":"course_001","semester":"114-2","grade":85}],"scoring":{"enabled":false}}
```

舊匹配以 ID 或課名＋學期精確查詢；重複或模糊的紀錄不任意選取。結果包含 `status`、`profile`、`evidence_details`、`skill_mappings`、`courses`、`issues`、`course_statuses` 及 `scoring`。可能因課程或模型失敗而只得到部分結果；無可用 Profile 時 `profile` 可為 null。

## 舊 Profile 與評分

舊 `StudentSkillProfile` 含可選 `student_id`、`skills`、`scoring_version` 和 `analysis_status`；`StudentSkill` 含舊 `skill_id`、名稱、`score`、`score_type`、`scoring_version`、證據、確認狀態、`dimension_scores` 與 `missing_dimensions`。五維為課綱關聯、成績、實作、作品／證照、近期性，權重依序為 0.4、0.2、0.2、0.1、0.1；缺任一維時完整 `score` 必須為 null。舊 Profile 產生器將五維標為未評估，技能未確認、證據 pending。

舊 Profile 使用 `data/seed/skills.json` 與 `skill_aliases.json` 精確映射，未知技能使用暫定 candidate ID；這些 ID 不是 ESCO URI，不能直接與新版結果互換。`data/seed/courses.json` 是 114-2 的 16 門課描述摘錄，待審查，並非完整課綱。

可選 `course_evidence_v0.2` sidecar 預設停用，啟用需設定 `scoring.enabled=true`；數字成績須明確指定 `numeric_scale: "0_100"`。它以課綱關聯 60% 與成績 40% 計算可用課程的支持度；缺任一維為 null，跨課取完整單課程分數最大值，不是五維總分或技能熟練度。引文、文字匹配、模型分類、制度及來源衝突都有額外限制；詳細實際規則以 `app/services/course_evidence_scoring.py` 與其測試為準。舊 Profile 與 sidecar 不會由正式 MCP 回傳。

舊版合成課程 Prompt 比較資料保存在 [skill_extraction_comparison.json](skill_extraction_comparison.json)，供追溯，不代表正式 MCP 的準確率。舊 API 對課綱內容進行模型判斷與逐字檢查，不能證明語意正確、學生能力或資料分享權限。

保留的詳細技術資料：[舊 Profile 彙整規則](skill_profile.md)、[舊評分 sidecar 規則](course_evidence_scoring.md)、[新舊技能萃取細節](skill_extraction.md)。
