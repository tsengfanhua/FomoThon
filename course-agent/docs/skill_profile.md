# 單課程結果彙整與 Student Skill Profile

> Legacy 相容文件：此五維 Profile 不是正式跨 Agent 契約；正式 MCP 使用 ESCO `conceptUri`，見 [README](../README.md)。

`build_skill_profile(results)` 接收單一使用者的多筆 `ExtractionResult` 或其 dict，不處理登入或 student_id。呼叫端必須先確認這些紀錄屬於同一人，且修課已確認；不得將不同人的結果混合。輸入也可包含 Course Matching 的失敗狀態；為保留失敗課程來源，呼叫端可在該狀態紀錄附上原始 `course_id` 與 `semester`。

```python
from app.services.skill_profile import build_skill_profile

result = build_skill_profile([course_result_1, course_result_2])
print(result.model_dump_json(indent=2))
```

## 彙整規則

- 只使用 `completed` 的 `skills`。`knowledge`、`topics` 保存在 `courses`，不轉成技能；未完成、失敗或不一致的結果不提供技能。
- 名稱以 Unicode NFKC、前後與重複空白整理、大小寫 casefold 產生比對鍵。完全吻合 `data/seed/skills.json` 名稱或 `data/seed/skill_aliases.json` 的明確別名時，採用共用清單的名稱與 `skill_id`，外層 `skill_mappings.mapping_status` 為 `mapped`。例如 `Python 程式設計`、`Python programming` 使用 `python`；`結構化查詢語言` 使用 `sql`。目前共用清單與別名仍是候選，`mapped` 不表示已獲全體 Agent 認可或證據已審查。
- 未對應名稱只在正規化後完全相同時合併，不使用模糊相似度或 LLM，`mapping_status` 為 `unmapped`，其暫定 ID 是 `candidate_v1_` 加正規化名稱的 UTF-8 SHA-256 完整值。新增共用名稱或別名後 ID 可能改變；舊版 `skill_v1_` 與此版 ID 不會自動遷移，持久化或跨 Agent 整合前須規劃對照及遷移。別名或名稱若指向多個共用 ID、或暫定 ID 前綴被占用，程式會報錯，不自行選擇。
- 同一 `course_id` + `semester` 的完全相同結果只處理一次；同一鍵有任何不同的結果時不選擇其中一筆，標記 `conflicting_course_results` 並要求確認。不同學期不視為同一紀錄。
- 相同技能、課程、學期及逐字引文只留一筆 evidence，並在 `evidence_details` 保留所有原名稱、理由、證據類型與文字比對等級；不同引文均保留。此處不計算支持度，也不以證據數推論能力。
- `evidence_details` 保留 `course_id`、課名、學期、原文、模型理由、證據類型和 `pending`。Profile 中 `SkillEvidence.evidence_reference` 此處承載原文引文，`source_type=course_description`、`source_section=description`；與既有文件中改寫摘要的範例用途不同，串接方不得假設這些引文可公開。共用 `SkillEvidence` 沒有學期欄位，需與 `evidence_details` 一起使用以保留來源資訊。
- 此 Service 假設輸入是已經過單課程 Service 的結果，並再次檢查 Pydantic 形狀；**沒有原始 `syllabus_text`，因此不會重新比對引文，也無法驗證模型語意正確性或上游是否真的執行過驗證**。不要將任意外部 JSON 當成已驗證來源。

## 狀態與契約轉換

外層狀態 `completed` 只代表輸入被成功彙整，並非人工確認；任何有效課程以外的失敗或證據不足使結果 `partial`。修課匹配多筆、重複、資料不足、學期不符、萃取需審查、課程結果衝突或輸入狀態矛盾時為 `needs_confirmation`。無法取得可彙整課程結果時為 `failed`；單有 `insufficient_evidence` 時為 `partial`，Profile 為空並標 `insufficient_data`。`issues` 提供原因代碼，`courses` 保留可取得的課程狀態；存在衝突的課程標為 `conflicting_results`。

共用 Schema v0.1 的 `StudentSkillProfile.analysis_status` 僅支援 `complete`、`partial`、`insufficient_data`，因此外層 `completed` 對應 `complete`；其他狀態有技能時對應 `partial`，無技能時對應 `insufficient_data`。完全沒有可用課程時 `profile` 為 null。共用 `StudentSkill` 沒有技能層級的 `review_status`，每個 `SkillEvidence.review_status` 及外層 `evidence_details.review_status` 保持 `pending`，`confirmed` 為 false；不得把它們視為已確認證據。

以下是虛構輸出片段，`profile` 可用 `StudentSkillProfile.model_validate(...)` 驗證：

```json
{
  "status": "completed",
  "profile": {
    "skills": [{
      "skill_id": "sql",
      "skill_name": "SQL",
      "score": null,
      "score_type": "not_evaluated",
      "scoring_version": "not_evaluated_v1",
      "confirmed": false,
      "evidence": [{
        "course_id": "synthetic_01",
        "skill_id": "sql",
        "source_type": "course_description",
        "source_section": "description",
        "relevance": null,
        "evidence_reference": "學習 SQL 查詢",
        "review_status": "pending"
      }],
      "dimension_scores": {
        "syllabus_relevance": {"weight": 0.4, "score": null, "status": "not_evaluated"},
        "course_grade": {"weight": 0.2, "score": null, "status": "not_evaluated"},
        "practice_project": {"weight": 0.2, "score": null, "status": "not_evaluated"},
        "portfolio_certification": {"weight": 0.1, "score": null, "status": "not_evaluated"},
        "recency": {"weight": 0.1, "score": null, "status": "not_evaluated"}
      },
      "missing_dimensions": ["syllabus_relevance", "course_grade", "practice_project", "portfolio_certification", "recency"]
    }],
    "scoring_version": "not_evaluated_v1",
    "analysis_status": "complete"
  },
  "evidence_details": [{
    "skill_id": "sql",
    "course_id": "synthetic_01", "course_name": "合成課程", "semester": "114-2",
    "evidence": "學習 SQL 查詢", "raw_skill_names": ["SQL"],
    "rationales": ["課程包含 SQL 查詢"], "evidence_bases": ["learning_objective"],
    "evidence_levels": ["name_in_quote"], "review_status": "pending"
  }],
  "skill_mappings": [{"skill_id": "sql", "skill_name": "SQL", "mapping_status": "mapped"}],
  "courses": [],
  "issues": []
}
```

五維只保留既有權重 40%／20%／20%／10%／10%，所有 `score` 為 null，`status` 為 `not_evaluated`。不實作評分公式；`score_type=not_evaluated`，不得以課程證據、LLM 信心、證據類型或重複數量推算學生熟練度。
