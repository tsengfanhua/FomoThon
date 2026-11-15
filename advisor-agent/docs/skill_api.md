# Skill Analysis API v0.1

## 啟動

使用專案 `.venv` 與已建立的 SQLite 課程資料庫。下例 seed 包含待審查的課程描述摘錄，僅供本機展示；它不是合成課程文字：

```powershell
.\.venv\Scripts\python.exe -m scripts.init_course_db --seed data/seed/courses.json --db data/processed/shared_course_demo.sqlite --allow-unreviewed-demo
$env:SKILL_DB_PATH = "data/processed/shared_course_demo.sqlite"
$env:SKILL_LLM_MODEL = "<可用模型名稱>"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

也可以在專案根目錄 `.env` 設定 `SKILL_DB_PATH`、`SKILL_LLM_MODEL` 和 `OPENAI_API_KEY`。程序環境變數優先於 `.env`，修改設定後請重啟服務。`SKILL_DB_PATH` 未設定時預設為上述 demo 路徑；資料庫不存在時不會自動建立，API 回傳 503。`SKILL_LLM_MODEL` 必須由部署者設定；既有 OpenAI client 從環境變數或專案 `.env` 取得金鑰。真實分析會傳送匹配的課程 ID、課名、學期及課程描述至外部 LLM，並可能產生成本；請先確認課程文字的分享權限。成績單原檔及成績不會送至 LLM。API 不處理登入或永久保存學生資料。

Swagger UI：`http://127.0.0.1:8000/docs`，OpenAPI：`/openapi.json`。

## POST /api/v1/skills/parse

以 `multipart/form-data` 的 `file` 上傳 PDF 或 XLSX。例如：

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/v1/skills/parse -F "file=@data/demo/synthetic_transcripts/case_duplicate_enrollment.xlsx"
```

回應包含 `status: needs_confirmation`、`enrollments`、`warnings` 與 `missing_fields`；使用者須確認修課紀錄後才提交分析。非 PDF／XLSX 為 415，無法解析為 422。既有解析器僅支援文字型、直線符號分欄 PDF，Excel 為 XLSX；掃描 PDF 不支援。無法辨識的成績會轉為 null 並給警告。

## POST /api/v1/skills/analyze

```json
{
  "enrollments": [
    {"course_id": "course_001", "semester": "114-2", "grade": 85},
    {"course_name": "課程名稱", "semester": "114-2", "grade": null}
  ],
  "scoring": {"enabled": true, "numeric_scale": "0_100"}
}
```

呼叫端必須先由學生確認資料；API 無法驗證實際確認過程。`course_id` 或 `course_name` 可用於匹配。`grade` 依共用契約限數字 0–100 或 null；此 API 暫不接受等第輸入。`scoring` 可省略，預設不評分；即使啟用，也必須明確指定 `numeric_scale` 才會將數字視為百分制。不得在未確認制度時指定。請勿送入姓名、學號等額外欄位；額外欄位會被拒絕。

回應包含 Profile service 原有的 `status`、`profile`、`evidence_details`、`skill_mappings`、`courses`、`issues`；新增 `course_statuses`（對應輸入順序，包含匹配狀態及分析狀態）與 `scoring`（停用時 null，啟用時為獨立 sidecar）。課程未匹配、模型失敗等狀態可與其他成功課程共存，屬處理結果而非 HTTP 失敗。所有課程均無法產生 Profile 時 `profile` 可為 null。資料庫不可用回傳 503；請求格式錯誤回傳不回顯輸入的 422。

`profile` 仍符合共用五維 Schema，技能為未確認、證據為 pending；sidecar 僅為實驗性修課證據支持程度，不是技能熟練度。詳見 `docs/course_evidence_scoring.md`。
