# Course Agent

Course Agent 將已確認的修課資料對應課綱，透過 LLM 與 ESCO 技能目錄產生可追溯的技能及課程證據。正式對外介面是 MCP stdio Tool **`analyze_student_courses`**。

流程：成績單／修課資料 → 人工確認 → 課程匹配 → LLM 選擇 ESCO 技能 → Skill Profile、課程證據與 Trace。MCP 接收已確認的修課 JSON，不直接解析上傳成績單。結果不是技能分數或熟練度，也不管理學生身分或媒合。

在 repository 根目錄完成環境與資料庫初始化後，從 `course-agent` 啟動：

```powershell
..\.venv\Scripts\python.exe -m app.mcp_server --course-db data/processed/course_index.sqlite --esco-db ../data/shared/esco_skills.sqlite --model <模型名稱>
```

隔離 Mock 示範（不呼叫付費 API）：

```powershell
..\.venv\Scripts\python.exe -m scripts.mcp_client_demo
```

五位學生的 JSON、XLSX、PDF 示範資料位於 [data/demo/synthetic_transcripts](data/demo/synthetic_transcripts/)；課程識別資料為真實資料，成績及學分為合成資料。

- [整合指南](docs/integration_guide.md)：環境、資料庫、MCP 契約與呼叫。
- [Legacy 相容說明](docs/legacy.md)：舊 HTTP API 非正式整合介面，暫時保留供既有呼叫端使用。

## 跨 Agent 技能串接：課程 → ESCO 技能的批次分析

為了與競賽、教師、整合網站串接（見上層 [README](../README.md)），新增批次分析，讓網站可以直接查「課程教哪些技能」與「學生修的課對應到哪些技能」：

```powershell
..\.venv\Scripts\python.exe -m scripts.init_course_db --data-dir <課綱資料夾> --db data/processed/course_index.sqlite --terms 114-1,114-2
..\.venv\Scripts\python.exe -m scripts.analyze_course_skills --year 114 --semester 2 --limit 50
Get-Content 已確認的修課.json | ..\.venv\Scripts\python.exe -m scripts.analyze_course_skills --enrollments-stdin
```

- `scripts.init_course_db` 新增 `--terms`：只取得部分學期的課綱時，可明確指定要匯入的學期（省略時仍要求四學期齊全）。
- `app/services/course_skill_batch.py`：課綱段落與儲存沿用本 Agent 既有的 `_syllabus_sections` 與 `save_course_skill`；對應流程改用與比賽、教師共用的 `shared/esco/mapper.py`（候選以短代號加名稱雙重核對，一項不合格只丟棄那一項）。另建 `course_analysis` 表記錄每門課的分析狀態，區分「分析過、沒有可對應的技能」與「還沒分析」。
- 預設同學期同名的多個開課班只分析一班作代表（`--all-sections` 可全部分析）；`--enrollments-stdin` 則只分析指定修課中尚未分析的那幾班，成績與學分不送給模型。
- MCP Tool `analyze_student_courses` 維持原樣，仍是本 Agent 對外的正式介面；批次分析是給整合網站預先建立資料用的。
