# Course Agent 決賽介紹與展示指南

> 給報告者的重點：Course Agent 以已確認的修課紀錄尋找課綱，從 ESCO 技能目錄選出有課綱原文支持的技能，並提供課程證據與 Trace。它描述課程教授的內容，**不等於測量學生能力**。

## 1. 解決的問題與系統定位

成績單通常以課程名稱呈現學習經歷；光看課名不容易比較不同課程實際涵蓋哪些技能，也難以回溯判斷依據。Course Agent 將每門課的課綱轉成以 ESCO `conceptUri` 識別的技能，保留來源課程、課綱欄位及引文，讓後續系統可以檢視資料來源。

在團隊規劃的系統中，網站後端或 Orchestrator 可負責接收資料、取得使用者確認並呼叫 Course Agent；Competition Agent、Advisor Agent 等可再依團隊約定使用技能資料。**這是團隊架構／整合規劃，本次 Course Agent 驗收不代表這些 Agent、Orchestrator 或網站已完成串接或通過整合測試。** Course Agent 不管理 `student_id`、不計算能力分數或熟練度、不進行學生媒合，也不負責完成其他 Agent 的整合。

正式介面是 MCP stdio Tool `analyze_student_courses`。它接收**已確認的修課 JSON**；成績單解析與使用者確認發生在 MCP 呼叫前，詳細啟動與資料契約見 [整合指南](integration_guide.md)。

## 2. 從修課紀錄到可追溯技能

```text
成績單／修課資料 → 解析並由使用者確認 → MCP 輸入
→ Course Resolver → 課綱 → LLM 英文搜尋詞 → ESCO 候選
→ LLM 選擇與引文 → 主資料及證據驗證 → 跨課程彙整 → 技能、來源與 Trace
```

1. **解析與確認（MCP 之前）**：既有工具可處理示範用 JSON、XLSX 與特定文字型 PDF；解析結果需要使用者確認。MCP 接收同一人的修課陣列，不接收 PDF／Excel 原檔，也無法自行證明使用者確實完成確認。PDF 僅支援文字型、以 `|` 分欄；XLSX 使用第一個工作表。
2. **課程匹配**：Course Resolver 依學年、學期、課名及提供的選課代碼查詢 Course SQLite；課名需精確匹配。唯一結果且課程介紹、目標、每週進度具備可用內容時，使用本地課綱。缺少代碼、名稱衝突或多筆候選等情況不應任選課程，會回報待確認或其他狀態。
3. **取得課綱與網站備援**：本地資料缺課或不完整時，若有足夠識別資訊且沒有代碼衝突，系統可檢查網站快取或查詢公開課綱。網站資料需核對學年、學期、代碼、課名、其他識別欄位與內容後才匯入；備援可能失敗，快取不自動過期。
4. **LLM 產生搜尋詞**：將清理後的課綱欄位提供給模型，產生最多六個簡短英文搜尋詞，供搜尋英文 ESCO 主資料。成績與學分不送入技能萃取模型。
5. **ESCO Repository 檢索**：使用搜尋詞查詢 ESCO 名稱與描述；每詞最多 20 筆，命中不足可嘗試簡化關鍵詞，去重後最多提供 30 個候選。這是文字檢索，不是語意檢索，因此可能漏掉相關技能。
6. **LLM 選擇技能與引文**：模型僅從候選 URI 選擇有課綱支持的項目，並回傳來源欄位及連續原文；它也可拒絕對應。沒有候選時不進行第二次模型選擇。
7. **驗證與儲存**：程式檢查模型輸出格式、URI 是否屬於候選且仍存在 ESCO Repository、引文是否逐字存在於指定課綱欄位。技能名稱與描述由 Repository 取回，並非採用模型自由編造的名稱。通過檢查的課程技能關聯可寫入 Course SQLite；任一選擇驗證失敗時該課結果進入待審查，不把失敗當成已確認技能。
8. **跨課彙整**：以 `conceptUri` 合併技能，來源證據按課程與引文保留並去重。相同 URI 在多門課出現時，可以在同一技能下查看多個課程來源；每門課失敗不會阻止其他課繼續。
9. **MCP 輸出與 Trace**：`skills` 提供 ESCO 主資料；`skill_evidence` 提供課程原文來源；`courses`、`issues`、`trace` 呈現課程狀態與處理過程。診斷欄位包括模型提出的 `unmapped` 原因，這些不是 ESCO 技能主資料。

逐字檢查只能證明引文存在，不能證明引文和技能的語意關係正確，也不能證明學生已掌握技能。

## 3. 為什麼結合 LLM 與 ESCO？

中文課綱用字多樣，LLM 可協助從上下文形成英文搜尋詞，再在候選中判斷哪些技能有原文支持。ESCO 則提供具名目錄和可跨系統辨識的 `conceptUri`，使同一技能不必依賴模型每次自由產生的名稱，並可回查名稱及描述。

這個做法把輸出限制在搜尋到的候選，但不保證語意正確：檢索可能漏掉候選，模型也可能選錯或誤解引文。ESCO 本身不是學生能力量表，也不能單憑 URI 宣稱完成跨 Agent 整合。

## 4. 五位學生 Demo 資料設計

[示範目錄](../data/demo/synthetic_transcripts/)包含 `student_demo_001` 至 `student_demo_005`，各有 JSON、XLSX 和 PDF。五位學生分別有 6、6、6、6、7 筆修課紀錄，共 **31 筆**；其中 005 的最後一筆成績為 null，用來呈現缺失值。

五人都有 114-2 的 `0772 Python程式設計與應用`、`1193 資料庫設計`，其他課程組合有所不同，並有部分跨學生重疊；可展示共同課程與不同學習背景。**學年、學期、選課代碼和課名取自真實課程索引；學分與成績是合成資料，學生也是示範對象**。共用課程不代表學生能力相同。

另有獨立的重複修課、缺成績及未匹配三組案例；未匹配案例故意錯配兩筆真實課程的名稱與代碼。這些案例與五位學生的 31 筆分開計算。Demo 新版內容目前尚未提交，隊友須取得包含它們的提交版本；課程資訊的分享權限和風險由資料持有人確認。

## 5. MCP 輸入與輸出示意

以下是**合成示意**，使用與 Mock Demo 相同的假資料；`uri:swift` 並非真實 ESCO URI。為便於閱讀，輸出中的 `trace` 只列出代表性事件，實際回應會含本次執行所記錄的其他步驟。資料的精確型別與錯誤處理見 [整合指南](integration_guide.md)。

輸入：

```json
{
  "enrollments": [
    {"academic_year":113,"semester":2,"course_code":"0001","course_name":"合成課程1","credits":3,"grade":80},
    {"academic_year":113,"semester":2,"course_code":"0002","course_name":"合成課程2","credits":3,"grade":80}
  ]
}
```

輸出示意：

```json
{
  "run_id": "11111111-1111-4111-8111-111111111111",
  "status": "complete",
  "courses": [
    {"status":"matched","skills_status":"mapped","course_id":"course-1","source":"local","unmapped":[]},
    {"status":"matched","skills_status":"mapped","course_id":"course-2","source":"local","unmapped":[]}
  ],
  "skills": [{"conceptUri":"uri:swift","preferredLabel":"Swift programming","description":"mock skill"}],
  "skill_evidence": [{"conceptUri":"uri:swift","sources":[
    {"course_id":"course-1","course_name":"合成課程1","source_section":"weeklyScds[0].tpd_learn","evidence":"練習 Swift 程式設計"},
    {"course_id":"course-2","course_name":"合成課程2","source_section":"weeklyScds[0].tpd_learn","evidence":"練習 Swift 程式設計"}
  ]}],
  "issues": [],
  "trace": [
    {"run_id":"11111111-1111-4111-8111-111111111111","step":"transcript_parsing","status":"success","duration_ms":0.1,"source":"confirmed_json"},
    {"run_id":"11111111-1111-4111-8111-111111111111","step":"profile_aggregation","status":"complete","duration_ms":0.1,"source":"course_agent"}
  ]
}
```

## 6. 真實 MCP 驗收案例

已保存的兩次正式 MCP stdio 驗收均為 `status=complete`、`outcome=verified`：

| 驗收 | 課程 | 核對結果 |
| --- | --- | --- |
| 單課 | 114-2／0772 Python程式設計與應用 | 1 項技能、1 筆原文證據、6 個 Trace 事件 |
| 同一次雙課呼叫 | 114-2／0772 Python程式設計與應用；114-2／1193 資料庫設計 | 前者 1 項、後者 7 項；共 8 個不同 `conceptUri`、8 筆原文證據、10 個 Trace 事件 |

雙課兩門均成功走過搜尋詞與候選選擇階段。依程式每門課各一次產生搜尋詞、一次選擇候選的成功路徑，可推得**共四次 OpenAI API 請求**；驗收報告本身沒有獨立保存 API 請求計數。不同執行情況如無候選或提早失敗，呼叫次數可能不同。

驗收程式核對課程匹配、ESCO URI／名稱／描述、技能去重、引文是否存在於指定課綱欄位、Trace 與無分數欄位。這是少量案例的結構與可追溯性驗證，**不是語意準確率、Precision／Recall 或學生能力驗證**。最近一次完整離線測試結果為 **120 passed、2 skipped**；它與真實課程 MCP 驗收是不同範圍的檢查。

兩份報告位於被 Git 忽略的 `course-agent/data/processed/mcp-acceptance/`，不隨 Clone 提供。報告保存技能主資料、課程序號、證據 SHA-256 與長度及 Trace，不保存成績單、課名、證據原文或 Prompt。雜湊、時間、run ID 與技能組合仍可能成為關聯線索，不能保證完全匿名；分享前須由資料持有人確認權限及風險。原始 MCP 回應的 `skill_evidence` 含課名與課綱引文，不能直接視為去識別化報告公開。

## 7. Trace 能說明什麼？

Trace 用同一個 `run_id` 串接每一步的名稱、狀態、耗時、來源及可能的錯誤碼，協助展示流程與定位失敗；它不包含輸入課程、課綱原文或 Prompt。`transcript_parsing` 在 MCP 中代表確認 JSON 的輸入檢查，**不是** MCP 解析了成績單檔案。

主要步驟包括 `transcript_parsing`、每課的 `course_resolution`、`esco_candidate_search`、`llm_skill_selection`、`skill_validation`，以及最後的 `profile_aggregation`；需要且實際呼叫網站時可能出現 `website_fallback`。`esco_candidate_search` 的時間涵蓋搜尋詞產生與候選查詢，Trace 事件數不直接等於 API 請求數。

本次雙課真實驗收的兩門課均由本地索引匹配，兩次搜尋、選擇與驗證均成功，最後完成彙整；沒有 `website_fallback`，也沒有加入部分失敗測試。網站備援、缺代碼與部分失敗有離線測試或 Mock 案例，但不能說已由這次雙課真實驗收證實。Trace 不持久化至服務端資料庫；本機驗收腳本另存經篩選的報告。

## 8. 決賽展示順序與講法

1. **問題與定位**：展示一張示範成績單，說明課名不等於技能；指出正式 Tool 的輸入是使用者確認後的修課 JSON。
2. **資料設計**：展示五位學生共有兩門課、其餘課程各有不同；清楚區分真實課程識別與合成成績／學分。
3. **流程**：以第 2 節流程圖講解匹配、課綱、兩階段 LLM、ESCO 候選及逐字驗證；強調 URI 來自候選、名稱與描述來自 ESCO。
4. **展示輸出**：顯示 `skills` 的 URI，再沿 `skill_evidence` 展開課程與來源。說明多課相同 URI 的證據可彙整，而課程涵蓋不代表學生熟練。
5. **展示 Trace 與限制**：指出成功與失敗狀態可供追查；講清楚本次真實驗收走本地索引，沒有驗證真實網站備援。
6. **展示驗收摘要**：使用第 6 節的單課與雙課數字，說明 `verified` 是結構及來源核對，不是語意準確率；是否能展示報告內容先確認權限。

若網站尚未完成，可在 `course-agent` 目錄執行以下隔離 Mock MCP Client，展示真實 stdio Tool 的呼叫與 JSON 回傳，再切換到已核准的真實驗收摘要／報告。Mock 使用合成課程、假 URI 與固定模型回應；不得將 Mock 結果稱為真實 ESCO 驗收：

```powershell
..\.venv\Scripts\python.exe -m scripts.mcp_client_demo
```

正式資料庫建立與啟動方式見 [整合指南](integration_guide.md)。正式模型呼叫可能計費且會傳送課綱內容，Demo 前需確認分享權限；不要為了展示而預設重跑付費驗收。

## 9. 評審可能提問

1. **為什麼不直接用課名產生技能？** 課名資訊不足；系統要求從課綱內容找支持引文，仍需人工判斷語意。
2. **為什麼使用 ESCO？** 它提供技能目錄及 `conceptUri`，有助識別與後續整合；不保證涵蓋所有課程技能。
3. **LLM 會不會編造技能？** 模型只能從檢索候選中選擇，程式檢查 URI 和引文；但語意選擇仍可能錯誤。
4. **為什麼要先產生英文搜尋詞？** 本機 ESCO 主資料使用英文，模型協助將中文課綱轉為搜尋詞；文字檢索可能漏掉候選。
5. **沒有匹配到 ESCO 怎麼辦？** 會保留 `unmapped` 或相關狀態供檢視，不應當作零技能或自行發明 ESCO URI。
6. **相同技能來自多門課怎麼處理？** 依 `conceptUri` 合併技能，保留不同課程及原文來源；不依課程數計算能力。
7. **如何確保引文正確？** 檢查引文是否逐字出現在指定課綱欄位；這不驗證其語意是否充分支持技能。
8. **成績高是否代表技能強？** 正式 MCP 不計算分數；課程成績也不是獨立的技能測量。
9. **成績單原檔是否送給模型？** MCP 接收已確認 JSON；技能萃取傳送課綱內容和候選，不傳成績或學分。課綱使用前仍需確認分享權限。
10. **找不到本地課綱怎麼辦？** 識別條件允許時可使用網站備援或快取；識別衝突或查詢失敗會回報狀態，不應任意選課。
11. **這次真實驗收有測到網站備援嗎？** 沒有，兩門皆由本地索引匹配；網站備援另有離線測試。
12. **`verified` 是否代表語意準確率高？** 不代表。這兩次只檢查有限課程的識別、主資料、逐字證據及 Trace，沒有標準答案可計算準確率。
13. **如果部分課程失敗，其他課程會消失嗎？** 不會因單課失敗就停止其他課；應檢查整體狀態、各課狀態與 `issues`。
14. **Trace 會記錄學生原始資料嗎？** 目前 Trace 記錄步驟、狀態、耗時、來源及錯誤碼，不記錄輸入課程或 Prompt；它本身也不是能力證明。
15. **已經串好網站與其他 Agent 了嗎？** 本次驗收範圍是 Course Agent MCP；網站、Orchestrator 和其他 Agent 的串接狀態需由團隊另行確認。
