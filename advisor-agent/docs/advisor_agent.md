# Advisor Agent MVP v0.1

## 功能

依競賽主題、需求技能及相關課程，對教師資料排序，並回傳逐項分數、命中項目、理由、證據識別碼、資料覆蓋率及資料警告。

## API

### `GET /api/v1/advisors`

讀取 `ADVISOR_DATA_PATH` 指向的 JSON（預設 `data/seed/advisors_extracted_all_609.json`）。

### `POST /api/v1/advisors/match`

```json
{
  "competition": {
    "competition_id": "C001",
    "competition_name": "AI 創新應用競賽",
    "topic": "人工智慧",
    "required_skills": ["機器學習", "Python"],
    "related_courses": ["人工智慧導論", "機器學習"],
    "competition_type": "AI"
  },
  "student": {
    "student_id": "S001",
    "completed_courses": ["Python 程式設計"],
    "skills": ["Python", "機器學習"]
  },
  "top_k": 5
}
```

`student` 欄位為相容既有 API 契約而保留，但學生修課關聯不納入教師評分。教師指導量能亦不蒐集、不評分。

## 評分

| Dimension | Weight |
|---|---:|
| expertise_match | 0.50 |
| course_match | 0.25 |
| competition_experience | 0.25 |

目前採精確／包含字串比對，不使用 LLM 推測語意。分數是可評估維度的加權平均，並回傳 `score_coverage`。資料未提供時，維度為 `missing`，不當成 0 分；已確認沒有匹配紀錄時才計 0 分。指導量能 unknown 不參與分數，且不代表教師同意指導。

## 教師資料

`data/seed/advisors_extracted_all_609.json` 包含 630 筆教師資料。`advisor_id`、`name`、`extracted_skills` 與 `competition_records` 已轉換為 API 使用的 `AdvisorProfile` 欄位；ESCO 技能 URI 放入 `expertise`，競賽紀錄放入 `advised_competitions` 與 `competition_evidence`。資料仍應在正式公開前由系所或教師確認。

欄位可使用 `null` 表示尚未取得；空陣列表示已查核但沒有該類資料。這兩者在評分時不同。

## 限制與後續

- 課程比對目前以已匯入開課資料為基礎；學生修課關聯與指導量能不屬於本版評分維度。
- `competition_evidence` 保存可追溯的競賽指導紀錄，包括標題、日期、來源 URL 及原文摘要。只有來源明確指出教師指導／共同指導的紀錄才匯入；只提及系所、團隊或教師個人獲獎而未明確指出指導關係者，不推定為指導經驗。
- 本版以規則式字串比對為主，後續可加入人工審核的技能同義詞表，再評估 embedding/LLM reranking。
- 不自動聯絡教師，也不判斷教師實際收生名額。
