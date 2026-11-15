# 修課技能證據評分 v0.2

> Legacy 相容文件：此可選評分 sidecar 僅供舊 HTTP API 保留，不是正式 MCP 或跨 Agent 契約。正式介面見 [README](../README.md)。

此結果是實驗性的修課證據支持程度，不是技能熟練度、準確率或已驗證的能力測量。分類與權重均為暫定設定，需經團隊與實證檢驗；引文存在不代表技能分類或語意正確。所有證據仍待審查，技能不自動確認。

## 串接與契約

原 `build_skill_profile(results)` 完全不變，未呼叫評分服務即為停用。共用五維 Schema 的權重及完整性驗證無法表示本版兩維總分，因此獨立回傳 sidecar；不可把 sidecar 分數填入原 Profile 的 `score` 或宣稱符合共用五維契約。以 `skill_id` 關聯，課程以 `course_id` + `semester` 關聯。原 Profile 與 `evidence_details` 仍須一併保留。

```python
from app.services.skill_profile import build_skill_profile
from app.services.course_evidence_scoring import score_course_evidence

profile_result = build_skill_profile(extraction_results)
scoring = score_course_evidence(profile_result, matched_courses, confirmed_enrollments,
                                numeric_scale="0_100", letter_grades={"A": 90})
```

`matched_courses` 每筆至少包含 `course_id`、`semester`、`syllabus_text`，必須是與萃取時相同的已匹配來源。`confirmed_enrollments` 每筆至少包含 `course_id`、`semester`、`grade`，呼叫端負責確認資料及匹配的可信度；服務本身無法證明確認或來源身分。`numeric_scale="0_100"` 只在適用的制度明確確認後提供；等第轉換表由呼叫端依實際制度提供，禁止套用通用預設。新版 Enrollment 僅支援 0～100 數字或 null，無效成績會回報供人工修正；舊版解析流程仍可能將無法辨識的等第設為 null。第三階段 ESCO 流程不使用本評分服務。

## 規則

- 對每筆候選，引文必須逐字出現在對應原文；`quote_in_source` 為 true／false，來源缺失或衝突則為 null。此檢查不做正規化或放寬。
- 獨立的 `support_match` 檢查技能名稱是否在引文逐字出現（`exact`），或只在技能名稱內多插入一個「的」（`inserted_de`）；其他情況為 `needs_review`。引文含「不」、「未」、「無」、「非」或「沒有」時一律為 `needs_review`，即使可能只是誤擋。此規則不判斷語意或反證，亦不等於人工確認；例如完全包含技能名稱仍可能出現在不支持的上下文，需人工審查。
- 原文存在且文字匹配時，使用模型分類的暫定值：`explicit_activity` 60、`learning_objective` 40、`course_scope` 20；其他情況關聯為 null。同一引文若有不同分類取最低值，同一課程的合格引文取最高值。模型分類及文字規則均不證明語意正確。
- 為相容舊消費端，`source_verified` 維持 v0.1 原意（引文在原文且技能名稱逐字出現），不能單獨用來判斷引文是否存在，也不包含新文字規則或否定詞檢查。新串接應分別使用 `quote_in_source` 和 `support_match`。
- 數字成績需指定百分制，等第須提供映射；缺失、無法轉換、超出 0–100、制度未知或同課程成績衝突時為 null。成績為課程整體的間接證據，不是技能測驗成績。
- 同一課程兩維皆可評估時，分數為 `0.6 × 關聯 + 0.4 × 成績`，四捨五入至小數點後兩位；任一維缺失時總分為 null，已知維度仍保留。同課程原文衝突時關聯為 null。
- 同一技能跨課程取完整單課程分數的最大值；不把不同課程的維度湊成完整分數，也不依課程數加分。重複資料不加分。每筆課程與引文仍保留，涵蓋情況由 `coverage`、`complete_course_count`、`course_count` 顯示；此總分只代表最佳完整課程紀錄，並不代表所有課程均已評估。
- `RULES` 集中定義版本、權重和分類值；變更規則時須同步更換版本並重新檢視意義。輸出保留原始成績、輸入的制度、引文、分類及各維結果以供追溯。五維中其餘維度未被此 sidecar 評估；原 Profile 保留 null。
