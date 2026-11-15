# Course Agent MCP 整合指南

## 環境與資料庫

以下以 Windows PowerShell 和 Python 3.12 為例，除標註外從 repository 根目錄執行。使用虛擬環境，不需安裝到全域：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\course-agent\requirements.txt
```

`course-agent/data/skills_en.csv` 及 `shared/esco` 初始化程式隨 repository 提供。ESCO 來源版本尚未確認；詳細來源與更新限制見 [共用 ESCO 文件](../../shared/esco/README.md)。

四學期原始課綱含個人聯絡資訊，未納入 Git。使用者表示已將 `課程資料.zip` 上傳團隊共享雲端；目前無法直接取得雲端檔案，實際下載位置、雲端檔案 SHA-256、壓縮結構及分享權限均**待資料持有人確認**。

本機另一專案中找到同名 `課程資料.zip`，唯讀檢查 SHA-256 為 `2f4d86b63a3b0d32bd13ebc1d971db85c1f1ec0a8c54e6b4b17c88005f1719a3`；根目錄為 `113-1/`、`113-2/`、`114-1/`、`114-2/`，直接包含 16,490 份 JSON，另有 4 筆目錄項目。此檢查**不能證明同名雲端檔案就是本機檔案**。舊交付紀錄另提及 `course-syllabi-1131-1142.zip`，其紀錄 SHA-256 為 `7555938a50efc23b42096fc3df813e1ca715cf82824047eb43c5f1f4c1e99063`，與上述本機檔案不同；不能判定雲端檔案只是舊檔改名或使用哪個雜湊。

取得雲端檔案後，先向資料持有人確認正確的 SHA-256 並比對，再檢查 ZIP 中的路徑，最後解壓到隔離的新資料夾。以下從 **repository 根目錄**執行，請先替換 ZIP 路徑；輸出資料夾應不存在：

```powershell
$courseZip = 'C:\path\to\課程資料.zip'
Get-FileHash -Algorithm SHA256 -LiteralPath $courseZip
Add-Type -AssemblyName System.IO.Compression.FileSystem
$courseArchive = [System.IO.Compression.ZipFile]::OpenRead($courseZip)
try { $courseArchive.Entries | Select-Object -First 20 FullName } finally { $courseArchive.Dispose() }
Expand-Archive -LiteralPath $courseZip -DestinationPath .\course-agent\data\processed\course-zip-extracted
```

**解壓後必須檢查目錄結構**：`--data-dir` 指定的同一個資料夾底下，應各有 `113-1`、`113-2`、`114-1`、`114-2`，或各自對應的 `113-1教學大綱`、`113-2教學大綱`、`114-1教學大綱`、`114-2教學大綱`；每個目錄直接包含該學期 JSON。可混用兩種名稱，但同一學期若兩種目錄都存在，匯入會停止並要求擇一；不自動掃描其他名稱或多層子目錄。若 ZIP 多包一層，應把 `--data-dir` 指向四個學期目錄的直接父目錄。下方示範假設該父目錄是解壓後的 `course-agent/data/processed/course-zip-extracted`；若實際結構不同，請依檢查結果調整路徑。不要覆蓋既有資料。

先建立 ESCO SQLite，再建立 Course SQLite：

```powershell
.\.venv\Scripts\python.exe -m shared.esco.init_db --csv .\course-agent\data\skills_en.csv --db .\data\shared\esco_skills.sqlite
Push-Location .\course-agent
..\.venv\Scripts\python.exe -m scripts.init_course_db --data-dir data/processed/course-zip-extracted --db data/processed/course_index.sqlite
Pop-Location
```

初始化依課程內容建立 ID，重複匯入相同來源不增加紀錄；資料更新時應使用新的空 Course SQLite 重建，避免混合快照。切換 ESCO 版本前需核對課程關聯。本機驗收快照為 16,490 門課、13,939 個 ESCO 技能，不保證其他來源版本有相同筆數。

### 初始化成功檢查

以下從 **repository 根目錄**執行；以 SQLite 唯讀模式檢查筆數，不會在路徑錯誤時建立空資料庫：

```powershell
.\.venv\Scripts\python.exe -c "import sqlite3,pathlib; p=pathlib.Path('data/shared/esco_skills.sqlite').resolve(); c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True); print('ESCO skills:',c.execute('select count(*) from esco_skills').fetchone()[0]); c.close()"
.\.venv\Scripts\python.exe -c "import sqlite3,pathlib; p=pathlib.Path('course-agent/data/processed/course_index.sqlite').resolve(); c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True); print('Courses:',c.execute('select count(*) from courses').fetchone()[0]); c.close()"
```

以下從 **`course-agent` 目錄**執行，使用本機已驗收課程識別資料檢查 Resolver；預期輸出 `matched`。若資料快照不同而找不到該課，應查明來源，不把錯誤當成技能為零：

```powershell
..\.venv\Scripts\python.exe -c "from pathlib import Path; from app.services.course_resolver import resolve_local_course; r=resolve_local_course(Path('data/processed/course_index.sqlite'), {'academic_year':114,'semester':2,'course_code':'0772','course_name':'Python程式設計與應用'}); print('Course resolution:',r['status'])"
```

若兩個 SQLite 有資料且解析顯示 `matched`，代表這項本地資料與匹配檢查通過；不代表模型萃取或完整 MCP 驗收已通過。

## 啟動與呼叫

正式模式在 `course-agent` 目錄設定 `OPENAI_API_KEY` 和 `SKILL_LLM_MODEL` 系統環境變數，或在 `course-agent/.env` 安全設定；系統環境變數優先。切勿提交金鑰。確認課綱可送往外部模型後啟動（可能計費）：

```powershell
..\.venv\Scripts\python.exe -m app.mcp_server --course-db data/processed/course_index.sqlite --esco-db ../data/shared/esco_skills.sqlite
```

Server 使用 stdio，應由 MCP Client 啟動子程序，而非當作 HTTP 服務。Client 以 `ClientSession` 初始化後呼叫 `session.call_tool('analyze_student_courses', {'enrollments': records})`；可參考 [Mock Client 程式](../scripts/mcp_client_demo.py) 的完整連線流程。若使用相對路徑，子程序工作目錄須為 `course-agent`；也可傳入資料庫絕對路徑。Client 應將必要的模型環境變數安全傳給子程序，不把日誌或金鑰寫入 stdout，以免干擾 MCP 通訊。

## 輸入

Tool 只接收一個 `enrollments` 陣列，表示呼叫端已確認的同一人的修課紀錄：

```json
{"enrollments":[{"academic_year":114,"semester":2,"course_code":"0772","course_name":"Python程式設計與應用","credits":3,"grade":85}]}
```

`academic_year` 為整數，`semester` 為 1–4，`course_name` 為非空字串；`course_code` 為字串或 null，請保留前導零。`credits` 為非負數或 null，`grade` 為 0–100 數字或 null；此三個欄位可省略。`selection_code` 是 `course_code` 的舊輸入別名。多餘欄位（包括 `student_id` 和 `course_id`）會被拒絕。缺少代碼可通過輸入格式驗證，但課程解析可能回報需要確認。成績與學分不送至 ESCO 萃取器，也不計算技能分數。

## 輸出

以下是欄位形狀示意；URI、文字與 ID 均為示例：

```json
{
  "run_id":"示例 UUID", "status":"complete",
  "courses":[{"status":"matched","skills_status":"mapped","course_id":"課程 ID","source":"local","unmapped":[]}],
  "skills":[{"conceptUri":"ESCO URI","preferredLabel":"ESCO 名稱","description":"ESCO 描述"}],
  "skill_evidence":[{"conceptUri":"ESCO URI","sources":[{"course_id":"課程 ID","course_name":"課名","source_section":"來源欄位","evidence":"課綱原文"}]}],
  "issues":[],
  "trace":[{"run_id":"示例 UUID","step":"transcript_parsing","status":"success","duration_ms":0.1,"source":"confirmed_json"}]
}
```

| 欄位 | 意義 |
| --- | --- |
| `skills` | ESCO 主資料，以 `conceptUri` 跨課程去重；名稱與描述來自 ESCO Repository。 |
| `skill_evidence` | 以 `conceptUri` 關聯來源課程、課綱欄位與逐字證據；一項技能可有多個來源。 |
| `courses` | 依輸入順序回傳課程解析狀態及 `skills_status`；匹配後可能含 `course_id`、`source`、`unmapped` 或 `reason`。 |
| `issues` | 需注意的課程索引、狀態及錯誤碼；空輸入的 issue 僅有 `error_code`。 |
| `trace` | 同一 `run_id` 的步驟、狀態、耗時及可選來源／錯誤碼；不包含輸入課程、原文或 Prompt。 |

`courses`、`issues`、`trace` 和 `courses[].unmapped` 都不是 ESCO 技能主資料。`unmapped` 是模型回傳的未可靠對應原因，不應當作技能。頂層 `complete` 表示無問題項目，**不保證一定找到技能**；部分成功為 `partial`，沒有成功課程為 `failed`，空陣列回傳 `invalid_input`。模型選擇與逐字驗證不證明語意正確，也不證明學生具備能力。

## 錯誤與限制

- SDK 在 Tool 輸入格式不符時直接回傳 MCP error，Tool 不執行，沒有 `run_id`；呼叫端應檢查 `isError`。
- 對有效輸入，逐課檢查 `courses`、`issues` 與頂層狀態；一課失敗不阻止其他課處理。代碼衝突、缺課綱、網站錯誤或模型驗證失敗不應視為零技能。
- 本地課綱不完整時可能使用公開網站備援；網站身分與內容需通過檢查，網站快取不自動過期。ESCO 候選搜尋是文字搜尋，可能遺漏；證據需人工審查。
- Server 啟動檢查資料表欄位；正式分析可將技能關聯與網站備援資料寫入 Course SQLite。尚未提供持久化 Trace、認證或遠端部署機制。
- PDF 解析僅支援文字型 `|` 分欄，XLSX 使用第一個工作表；不是任意成績單 OCR。MCP 本身只接收確認後的 JSON。

### 基本排查

- **資料庫缺失／無法開啟**：先確認執行目錄及 `--course-db`、`--esco-db` 指向實際檔案；按上述順序建立 ESCO 與 Course SQLite，勿把舊 HTTP API 資料庫當新版索引。
- **找不到課綱／兩個目錄衝突**：檢查 `--data-dir` 是否是四個學期目錄的直接父目錄、每個目錄是否有 JSON；同一學期同時存在標準與後綴名稱時，先確認來源再擇一，避免混用。
- **模型設定缺失**：確認正式 Server 的子程序可取得 `SKILL_LLM_MODEL` 或 `--model`，以及 `OPENAI_API_KEY`；系統環境變數優先於 `course-agent/.env`。不要輸出或提交金鑰。
- **MCP Client 無法啟動**：先從 `course-agent` 執行下方 Mock 指令，檢查虛擬環境與依賴、子程序工作目錄及 stderr；正式 Client 要設定正確的 Python 路徑、資料庫路徑與環境變數，並保留 stdout 給 stdio 協定。Mock 成功不代表正式金鑰或資料庫已驗證。

## Mock 與整合責任

在 `course-agent` 目錄執行：

```powershell
..\.venv\Scripts\python.exe -m scripts.mcp_client_demo
..\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider --basetemp "$env:TEMP\course-tests-$(Get-Random)"
```

Mock 使用臨時資料庫及固定模型回應，不需要正式課綱、ESCO 資料庫或 API Key；`--mock` 僅允許有測試標記的隔離資料庫。完整測試亦不需付費 API，部分測試可能依本機資料或字型條件跳過。

網站後端／Orchestrator 負責身分、授權、成績單處理與人工確認、將同一人的資料傳入 Tool、啟動並管理 MCP Client、處理錯誤及決定資料保存策略。Course Agent 負責課程解析、課綱與 ESCO 關聯、課程證據及執行 Trace；不負責學生 ID、學生媒合、技能分數或熟練度。不要把課程證據直接解讀成學生能力。
