# 單課程技能萃取

## 新版 ESCO 對應

以下從 repository 根目錄執行；Python 搜尋路徑必須包含根目錄與 `course-agent`。資料庫需先依 README 初始化，模型及金鑰由呼叫端設定：

```powershell
$env:PYTHONPATH = "$PWD;$PWD/course-agent"
```

```python
from pathlib import Path
from shared.esco.repository import EscoRepository
from app.services.llm_client import OpenAIClient
from app.services.skill_extraction import extract_esco_skills

courses = Path("course-agent/data/processed/course_index.sqlite")
esco = EscoRepository(Path("data/shared/esco_skills.sqlite"))
client = OpenAIClient(model="自行指定已獲授權的模型")
result = extract_esco_skills(courses, esco, "已查詢到的課程內部 ID", client)
```

實際呼叫會把指定課程的名稱、學期、選課代碼、清理後的課綱文字與最多 30 筆 ESCO 候選送到外部服務，並可能計費；使用前須確認課綱文字的分享權限。輸出 `mapped` 只表示模型與程式驗證接受，不代表人工確認語意。`unmapped` 表示沒有可靠對應或候選，`needs_review` 表示模型輸出或證據未通過驗證，`failed` 表示模型呼叫失敗；`not_found` 表示課程不存在。重複關聯保留第一次的原文證據。

## 舊版萃取契約

以下描述舊 HTTP API 保留的萃取流程，不是正式 MCP 的 ESCO 輸出契約。

此 Service 以 Course Matching 的成功結果 `result["course"]` 為輸入，不查詢資料庫或判斷匹配是否成功。呼叫端只能傳入 `status == "matched"` 的課程；失敗及重複紀錄不可送入。輸入必須含 `course_id`、`course_name`、`semester`、`syllabus_text`；可含既有 `credits` 等額外課程欄位。服務不接收成績單或學生識別資料。

```python
from app.services.llm_client import OpenAIClient
from app.services.skill_extraction import extract_course_skills

# matching_result 來自 match_enrollments，且其 status 為 matched。
client = OpenAIClient(model="自行指定支援 JSON mode 的模型")
result = extract_course_skills(matching_result["course"], client)
print(result.model_dump_json(indent=2))
```

建立 `OpenAIClient` 時會自動載入專案根目錄 `.env` 的 `OPENAI_API_KEY`；若程序環境已有同名變數，環境變數優先。模型由呼叫端指定；不在程式碼放置金鑰。此呼叫會送出課程名稱、ID、學期與課程描述到外部服務並可能計費。實際使用前須確認資料分享授權及模型可用性；專案規範禁止將真實成績單送至外部 LLM。目前 seed 是 `pending` 的課程描述摘錄，不是完整課綱，來源及分享權限尚待審查。無須依賴 `skills.json`。

模型的 user message 為 JSON，例如：

```json
{"course_id":"synthetic_01","course_name":"合成程式課程","semester":"114-2","syllabus_text":"學生練習使用 Python 讀取 CSV 資料。"}
```

system message 要求只依描述區分技能範疇、知識概念及課程主題，不推測學生能力；三類均須提供理由及連續原文證據。技能不強制使用動詞命名，具體操作可作為較廣技能範疇的證據。預期模型回覆例如：

```json
{"skills":[{"raw_skill_name":"Python 程式設計","rationale":"課程包含使用 Python 的練習。","evidence":"學生練習使用 Python 讀取 CSV 資料。","evidence_basis":"explicit_activity"}],"knowledge":[],"topics":[]}
```

Service 輸出是 Pydantic `ExtractionResult`，可用 `model_dump()` 供後續跨課程階段使用。以下是示意，非真實模型測試結果：

```json
{
  "course_id": "synthetic_01",
  "course_name": "合成程式課程",
  "semester": "114-2",
  "status": "completed",
  "skills": [{
    "raw_skill_name": "Python 程式設計",
    "normalized_skill_name": "Python 程式設計",
    "skill_id": null,
    "rationale": "課程包含讀取資料的練習。",
    "evidence": "學生練習使用 Python 讀取 CSV 資料。",
    "evidence_basis": "explicit_activity",
    "evidence_level": "contextual_quote",
    "review_status": "pending"
  }],
  "knowledge": [],
  "topics": [],
  "attempts": 1,
  "error_reason": null
}
```

`normalized_skill_name` 目前只去除前後空白，不做同義詞合併、翻譯或跨課程正規化。`skill_id` 保留 null，未建立可跨課程使用的識別規則；不可依此欄位彙整。此輸出也不是舊版 `SkillEvidence` 或 `StudentSkillProfile`。

新輸出新增 `knowledge` 和 `topics` 陣列，模型回覆必須提供這兩個欄位；每項包含 `name`、`rationale`、`evidence`，Service 加上 `review_status: pending`。舊版僅有 `skills` 的模型回覆會被視為格式錯誤。若僅有概念或主題而沒有技能，狀態為 `insufficient_evidence`，但仍保留已通過引文檢查的概念及主題。

分類與技能範疇由模型依 Prompt 判斷，程式不能保證語意分類正確；短引文也可能脫離上下文。模型可能把同一內容分別標為概念和主題，這些是待審查結果，不能直接視為獨立技能。合成課程真實 API 的不同 Prompt 結果保存在 [skill_extraction_comparison.json](skill_extraction_comparison.json)，其中 `knowledge_basis_check` 為目前 Prompt 的測試結果。測試的例子與 Prompt 例子相近，並非獨立評估，不能證明普遍改善。

`evidence_basis` 由 LLM 判斷：`explicit_activity` 指引文明確描述課程實作、練習或任務；`learning_objective` 指明確操作、分析或設計等學習目標但未描述實際練習；`course_scope` 指僅列出課程能力範圍。舊值 `explicit_practice` 不再接受，舊結果不會自動轉換，需檢視原文後重新分類。Pydantic 只驗證選項，不能證明分類正確。這與下方程式計算的 `evidence_level`（名稱是否逐字出現在引文）不同；都不代表學生具備技能。

- `name_in_quote`：原文證據逐字存在，且技能名稱也逐字出現在證據中。
- `contextual_quote`：原文證據逐字存在，但技能名稱沒有逐字出現在該引文中；語意關聯需要審查。

兩種等級都只代表字串檢查，不證明技能、理由或教學關聯的語意正確，也不是準確率或模型信心。所有結果均為 `pending`，代表待審查的課程教授內容，不代表學生能力或熟練度。

若描述空白或模型回傳空技能清單，狀態為 `insufficient_evidence`；後者是模型判斷，並非客觀證明課程沒有技能。格式錯誤或任何一項證據不在原文時，整筆回覆最多重試一次，仍失敗則為 `needs_review`，`error_reason` 為 `invalid_llm_output` 或 `evidence_not_in_source`；不回傳部分技能。API 呼叫失敗立即回傳 `failed`、`llm_api_error`，不自動重試，也不洩漏原始錯誤訊息。SDK 自動重試已關閉。`attempts` 記錄呼叫次數。輸入不符合課程欄位契約時會拋出 Pydantic 驗證錯誤。
