了解，主人～這次我們重新調整整體架構，讓它符合你們團隊真正的工作分配。

依照你提供的《FomoThon》提案簡報及現有 Demo，我建議採用 Python FastAPI 作為後端，並將三位碩士班與兩位學士後專班隊員的責任明確分離。

最重要的是：你們碩士班三人專注 AI Agent、資料分析與後端 API，不需要負責前端或隊友媒合演算法。

# Fomo鬆（FomoThon）MVP 系統架構規格書 v2.0

PROJECT OVERVIEW

2026/11/13 截止

# Python Multi-Agent Backend

Agentic AI 校園競賽協作媒合平台 · 決賽前 MVP

3 個 AI Agent

碩士班負責

2 個系統模組

學士後負責

4 個開發日

11/9–11/12

## 一、團隊分工與 MVP 範圍

| 開發人員  | 主要負責       | 工作內容              |
| ----- | ---------- | ----------------- |
| 碩士班 A | 能力盤點 Agent | 修課紀錄、課綱分析、能力萃取    |
| 碩士班 B | 比賽分析 Agent | 競賽資料、資格判斷、能力缺口    |
| 碩士班 C | 教師媒合 Agent | 教師專長分析、指導老師推薦     |
| 學士後 A | 前端系統       | UI、表單、結果展示、API 串接 |
| 學士後 B | 隊友媒合系統     | 隊友資料、匹配、邀請與組隊功能   |

由碩士班三人共同負責後端整合、資料庫、Orchestrator、測試與 Agent Trace，並指定其中一人擔任整合負責人。

這也表示，整個平台可以有四個 Agent 的設計，但你們目前只需要真正開發其中三個新的 Agent。隊友媒合可由學士後團隊維持原本的系統邏輯，再透過 API 與 Agent 工作流程整合。

## 二、整體系統架構

Frontend Web Application

學士後 A｜修課上傳、競賽搜尋、教師推薦、隊友媒合 UI

HTTP / JSON REST API

Python FastAPI

碩士班後端 API

Validation · Agent Runs · Results

Teammate Matching Service

學士後 B｜隊友媒合

Profiles · Matching · Invitations

Multi-Agent Orchestrator

Goal Parser · State Machine · Gap Gate · Replan / Stop

Skill Agent

課綱 × 修課 × 能力

Competition Agent

資格 × 難度 × 缺口

Advisor Agent

教師專長 × 比賽需求

SQLite

業務資料

Source Data

課綱、簡章、教師資料

Trace / Evidence

執行紀錄與引用證據

### 技術選型

| 技術層級                | 建議技術           | 選擇原因              |
| ------------------- | -------------- | ----------------- |
| Backend             | Python 3.11+   | 三人熟悉、AI 套件多       |
| API                 | FastAPI        | 自動產生 Swagger、容易串接 |
| Validation          | Pydantic v2    | 統一 Agent 輸入輸出     |
| Database            | SQLite         | 不需額外部署 DB Server  |
| ORM                 | SQLAlchemy     | 管理資料模型            |
| Agent Orchestration | Python 狀態機     | 流程透明、快速開發         |
| LLM                 | 可設定的 LLM API   | 文件解析與能力萃取         |
| Testing             | pytest + httpx | API 與 Agent 測試    |
| Logging             | JSONL / SQLite | Trace 與評測紀錄       |

我不建議這週導入 LangChain、LangGraph、Celery、Redis、Neo4j 或 Docker 作為必要依賴。以目前期限，使用 Python 原生狀態機就足以驗證 Agentic Workflow。

## 三、後端功能規格

以下是重新整理的完整後端規格，可以直接提供給三位碩士班成員，作為開發與任務分工依據。

# Fomo鬆（FomoThon）MVP 後端系統架構規格書

**版本：** v2.0\
**技術：** Python + FastAPI + SQLite\
**交付日期：** 2026/11/13\
**開發人力：** 碩士班 3 人（後端）、學士後專班 2 人（前端與隊友媒合）\
**文件定位：** 決賽前 MVP 開發規格

## 1. 系統目標

建立一套 AI Agent 校園競賽分析平台，整合學生修課紀錄、學校課綱、競賽資訊及教師研究專長，協助學生分析自身能力、評估競賽適合程度，並尋找合適的指導老師。

本階段後端主要實作三個 Agent：

1. Skill Analysis Agent：學生能力盤點。
2. Competition Analysis Agent：競賽分析與能力缺口評估。
3. Advisor Matching Agent：指導老師專長分析與推薦。

由 Agent Orchestrator 管理任務流程，並提供 API 給前端系統與隊友媒合模組使用。

## 2. 系統邊界

### 2.1 碩士班負責

- Python FastAPI 後端服務
- 修課與課綱分析
- 比賽資料分析
- 教師專長分析
- Agent Orchestrator
- Agent Trace 與 Evidence
- 資料庫及核心資料處理
- API 文件與後端評測

### 2.2 學士後專班負責

- 前端介面
- 學生資料輸入與結果展示
- 隊友媒合演算法與系統
- 組隊邀請及相關互動流程
- 前後端整合

隊友媒合系統必須能使用後端輸出的 `skill_profile` 和 `skill_gaps`，但內部排名演算法不由碩士班實作。

### 2.3 本週不開發

- 正式學校 SSO
- 全校學生與教師資料自動同步
- 自動寄送真實教師邀請
- 大規模網路爬蟲
- 完整多租戶權限管理
- 複雜即時通知服務

## 3. Agent 功能規格

### 3.1 Skill Analysis Agent

**功能目的**

依據學生修課紀錄及學校課程大綱，分析學生可能具備的專業能力，並保存可追溯的證據。

**輸入資料**

| 欄位          | 說明          |
| ----------- | ----------- |
| student_id  | 學生識別碼       |
| department  | 就讀科系        |
| course_id   | 課程代碼        |
| course_name | 課程名稱        |
| grade       | 修課成績（選填）    |
| semester    | 修課學期        |
| syllabus    | 課綱內容        |
| projects    | 作品或課堂專題（選填） |

**處理流程**

1. 接收學生修課紀錄。
2. 依課程代碼查詢對應課綱。
3. 取得課程目標、授課內容及技能關鍵字。
4. 將課程內容對應至標準化技能標籤。
5. 計算課程對各項技能的支持程度。
6. 整合不同課程的能力證據。
7. 產生學生技能檔案。
8. 提供學生人工確認。

**評分規則**

依照提案內容：

| 評分維度    | 權重  |
| ------- | --- |
| 課綱技能關聯  | 40% |
| 修課成績    | 20% |
| 實作／專題比重 | 20% |
| 作品／證照佐證 | 10% |
| 修課時間    | 10% |

實作時應使用固定、版本化的評分規則。沒有成績或作品等資料時，標示缺少證據，不得自行推定學生具有相關經歷。

多門課的技能彙整必須有明確規則，避免修課數量增加就無限制提高分數。

**能力輸出範例**

```
{
  "student_id": "S001",
  "skills": [
    {
      "skill_id": "SK001",
      "skill_name": "Python",
      "score": 85,
      "evidence_level": "course_supported",
      "source_course_ids": ["CS101", "CS205"],
      "confirmed": false
    }
  ]
}
```

這裡的分數是 MVP 推估值，不代表經標準化能力測驗驗證的實際能力。

### 3.2 Competition Analysis Agent

**功能目的**

分析競賽資格、競賽主題、難度及所需能力，並與學生能力檔案進行比對。

**輸入資料**

- 學生科系與身分
- 已確認的學生技能檔案
- 比賽名稱、主題、簡章
- 報名資格與限制
- 截止日期
- 所需技能
- 歷屆競賽資料（如有）

**處理流程**

1. 取得競賽資料。
2. 分析比賽主題及需求。
3. 檢查學生參賽資格。
4. 排除已知不符合資格的比賽。
5. 比對學生技能。
6. 產生技能缺口。
7. 計算競賽適配分數。
8. 產生推薦理由。

**評分規則**

| 評分維度    | 權重  |
| ------- | --- |
| 主題與能力相符 | 30% |
| 能力缺口可補  | 20% |
| 難度與競爭強度 | 20% |
| 時程可行    | 15% |
| 學習與延伸價值 | 15% |

**資格判斷**

使用三態：

- `eligible`：已確認符合。
- `ineligible`：已確認不符合。
- `unknown`：資料不足，無法確認。

資格不符的競賽不得標示為可報名；資料不足不能當成資格通過。

**輸出範例**

```
{
  "competition_id": "C001",
  "eligibility": "eligible",
  "fit_score": 78,
  "matched_skills": [
    "Python",
    "Machine Learning"
  ],
  "skill_gaps": [
    {
      "skill_id": "SK005",
      "skill_name": "UI Design",
      "required_score": 70,
      "current_score": 30,
      "gap": 40
    }
  ],
  "requires_advisor": true,
  "evidence_ids": ["E101", "E102"]
}
```

`skill_gaps` 將提供給學士後負責的隊友媒合系統，作為尋找互補隊友的依據。

### 3.3 Advisor Matching Agent

**功能目的**

根據競賽主題與專業技能需求，分析教師研究專長、授課領域及指導經驗，推薦合適的指導老師。

**輸入資料**

- competition_id
- 競賽主題
- 比賽所需技能
- 學生已修課程
- 教師專長與研究領域
- 教師授課資料
- 教師競賽指導經歷（如有）

**處理流程**

1. 取得比賽主題。
2. 查詢教師資料。
3. 比對教師研究專長。
4. 比對開授課程。
5. 檢查既有指導經歷。
6. 計算教師適配分數。
7. 產出排序、原因及證據。

**評分規則**

| 評分維度    | 權重  |
| ------- | --- |
| 專長領域相符  | 40% |
| 開授相關課程  | 20% |
| 曾指導同類比賽 | 20% |
| 學生修課關聯  | 10% |
| 指導量能    | 10% |

指導量能與教師是否願意指導通常無法僅從公開專長資訊確認。因此，沒有確認的資料必須標示 `unknown`，教師推薦也不代表指導關係已成立。

**輸出範例**

```
{
  "competition_id": "C001",
  "advisors": [
    {
      "teacher_id": "T001",
      "teacher_name": "示例教師",
      "match_score": 88,
      "expertise": [
        "Artificial Intelligence",
        "Machine Learning"
      ],
      "availability": "unknown",
      "reasons": [
        "研究專長與比賽主題相符",
        "開授相關專業課程"
      ],
      "evidence_ids": ["E201", "E202"]
    }
  ]
}
```

## 4. Agent Orchestrator

MVP 使用 Python 狀態機管理 Agent 流程，不引入額外的 Agent Framework。

### 4.1 基本工作流程

```
START
  |
  v
Goal Parser
  |
  v
Skill Analysis Agent
  |
  v
Competition Analysis Agent
  |
  v
Gap Gate
  |
  +-- 資格不符 --> 嘗試其他比賽
  |
  +-- 技能不足 --> 輸出 skill_gaps
  |                   |
  |                   +--> 隊友媒合系統
  |
  +-- 需要指導 --> Advisor Agent
  |
  v
Result Aggregation
  |
  v
Human Confirmation
  |
  v
END
```

### 4.2 MVP 動態決策

- 當資格不符合時，可搜尋其他已收錄的競賽。
- 當需要教師時，呼叫 Advisor Agent。
- 當存在技能缺口時，產生 `skill_gaps` 並供隊友媒合系統使用。
- 當證據不足時，輸出缺少資料的資訊。
- 當搜尋已達上限、沒有新候選或出現工具失敗時，停止流程。

本週不需要實作完整自主規劃型 Agent；以可追溯的條件式規劃與狀態轉移為優先。

## 5. API 規格

### 5.1 能力分析

`POST /api/v1/skills/analyze`

接收修課紀錄或已存入的 student_id，執行技能分析。

`GET /api/v1/students/{student_id}/skills`

取得學生能力檔案。

`POST /api/v1/students/{student_id}/skills/confirm`

確認技能推估結果。

### 5.2 比賽分析

`GET /api/v1/competitions`

查詢比賽資料。

`POST /api/v1/competitions/analyze`

執行資格檢查及競賽適配分析。

### 5.3 教師推薦

`GET /api/v1/advisors`

取得教師資料。

`POST /api/v1/advisors/match`

依競賽主題推薦教師。

### 5.4 Agent 管理

`POST /api/v1/agent/runs`

建立 Agent 工作流程。

`POST /api/v1/agent/runs/{run_id}/steps`

執行下一階段。

`GET /api/v1/agent/runs/{run_id}`

取得工作流程狀態及結果。

`GET /api/v1/agent/runs/{run_id}/trace`

取得 Agent 執行紀錄。

`GET /api/v1/agent/runs/{run_id}/evidence`

取得推薦證據。

### 5.5 隊友媒合系統整合

碩士班提供以下結構給隊友媒合模組：

```
{
  "student_id": "S001",
  "competition_id": "C001",
  "skill_profile": [
    {
      "skill_id": "SK001",
      "score": 85,
      "confirmed": true
    }
  ],
  "skill_gaps": [
    {
      "skill_id": "SK005",
      "required_score": 70,
      "current_score": 30
    }
  ]
}
```

學士後團隊自行實作匹配與邀請邏輯。

後端不直接操作隊友媒合資料庫，改透過雙方約定的 API 或整合介面交換資料。

## 6. 資料庫規格

MVP 使用 SQLite。

主要資料表：

| 資料表                | 用途       |
| ------------------ | -------- |
| students           | 學生基本資料   |
| courses            | 課程及課綱    |
| enrollments        | 修課紀錄     |
| skills             | 標準技能標籤   |
| course_skills      | 課程與技能關聯  |
| student_skills     | 學生能力檔案   |
| competitions       | 比賽資料     |
| competition_skills | 比賽需求技能   |
| advisors           | 教師資料     |
| advisor_expertise  | 教師專長     |
| advisor_courses    | 教師開課關聯   |
| agent_runs         | Agent 任務 |
| agent_events       | 執行事件     |
| evidence           | 可追溯證據    |

建議將課程、比賽及教師資料透過 JSON Seed 匯入 SQLite，以確保展示環境可重建。

## 7. 程式架構

```
fomothon-backend/
├── app/
│   ├── main.py
│   ├── api/
│   │   └── v1/
│   │       ├── skills.py
│   │       ├── competitions.py
│   │       ├── advisors.py
│   │       └── agent_runs.py
│   ├── agents/
│   │   ├── skill_agent.py
│   │   ├── competition_agent.py
│   │   └── advisor_agent.py
│   ├── orchestrator/
│   │   ├── workflow.py
│   │   ├── state.py
│   │   └── decision_rules.py
│   ├── services/
│   │   ├── scoring.py
│   │   ├── llm_parser.py
│   │   ├── evidence.py
│   │   └── trace.py
│   ├── schemas/
│   │   ├── skills.py
│   │   ├── competitions.py
│   │   ├── advisors.py
│   │   └── agent.py
│   ├── models/
│   │   └── database.py
│   ├── repositories/
│   └── core/
│       ├── config.py
│       └── database.py
├── data/
│   ├── courses.json
│   ├── competitions.json
│   └── advisors_extracted_all_609.json
├── scripts/
│   ├── init_db.py
│   └── export_traces.py
├── tests/
│   ├── test_skills.py
│   ├── test_competitions.py
│   ├── test_advisors.py
│   └── test_workflow.py
├── evaluation/
│   ├── cases.json
│   ├── expected.json
│   └── traces/
├── docs/
│   ├── architecture.md
│   ├── api.md
│   └── evaluation.md
├── .env.example
├── .gitignore
├── pyproject.toml
└── README.md
```

## 8. Agent Trace 規格

所有 Agent 執行必須有唯一的 `run_id`。

至少保存：

- run_id
- step_id
- agent_name
- action
- input_summary
- source_ids
- decision
- output_summary
- status
- timestamp
- error_message（如有）

輸出以 JSON 為主，應能在測試結束後匯出。

Trace 必須記錄真正發生的操作，不應預先產生虛構的工具呼叫紀錄。

## 9. MVP 評測規格

**能力盤點**

- 課程技能對應是否正確
- 課綱來源是否可追溯
- 缺少課綱時是否正確處理

**比賽分析**

- 資格判斷是否正確
- 截止日判斷是否正確
- 技能缺口是否符合預期

**教師推薦**

- 教師專長是否與競賽相關
- 推薦排序是否符合既定規則
- 是否保留教師資料來源

**Orchestrator**

- 是否正確派發 Agent
- 是否能依結果切換流程
- 是否能正常停止
- 是否產生完整 Trace

至少提供正常案例、資格不符案例、缺少資料案例及完整流程案例，並將預期輸出與實際輸出分開保存。

## 10. 交付項目

2026/11/13 前，碩士班後端應交付：

1. Python FastAPI 原始碼。
2. 可啟動的 API Server。
3. 固定測試資料集與初始化腳本。
4. 三個 Agent 的可執行模組。
5. Agent Orchestrator。
6. Swagger API 文件。
7. README 與架構說明。
8. pytest 測試與結果。
9. Agent Trace JSON。
10. Agent 評測案例、預期結果與實際結果。
11. 已知限制、模型使用與資料來源說明。

系統必須能在沒有前端的情況下透過 Swagger 執行核心功能。

## 11. MVP 驗收標準

- 三個 Agent 均可獨立透過 API 執行。
- 修課資料可轉換為具證據的能力檔案。
- 比賽分析可檢查資格並計算技能缺口。
- 指導老師可依主題及專長排序推薦。
- Orchestrator 能完成一條端到端工作流程。
- API 可提供隊友媒合所需的能力資料。
- 所有推薦有可追溯的理由與來源。
- 評測資料可重複執行。
- README 可供其他隊員啟動與驗證系統。

**核心驗收情境：** 學生輸入「我想參加 AI 黑客松」，系統能根據其修課及課綱資訊產生能力檔案，分析競賽資格與能力缺口，並推薦相關指導教師；隊友媒合系統可取得能力缺口資料供後續匹配。

## 四、三位碩士班的實際開發分工

我建議採取「三人各自完成一個 Agent，所有人共用同一套資料介面」的方式。

各 Agent 的獨立開發邊界

成員 A

Skill Agent

課程、技能、能力分數、證據

成員 B

Competition Agent

資格、適配度、技能缺口

成員 C

Advisor Agent

教師專長、課程、推薦排名

共用 Pydantic Schema + API Contract

確保三個 Agent 的輸入與輸出可以互相銜接

共同整合 Orchestrator

串接 · Trace · 測試 · README

要避免的一個問題是：三個人都使用 Codex 各自開發，但一人輸出 `skills`、一人接收 `student_abilities`、另一人需要 `competencies`，結果整合時才發現完全不相容。

因此第一天就必須確定共用的 `StudentSkill`、`CompetitionRequirement`、`SkillGap`、`AdvisorRecommendation` 與 `AgentResult` 資料模型。

## 五、四天開發與整合時程

11/9

週一

架構與資料契約確認

建立 GitHub Repo、FastAPI 專案、Pydantic Schema、資料庫初版，分配各 Agent。

11/10

週二

三個 Agent 平行實作

各自完成資料讀取、分析邏輯、API 與基本測試，至少能單獨執行。

11/11

週三

Agent 整合與狀態機

接通三個 Agent，完成 Gap Gate、推薦結果與 Trace。

11/12

週四

系統驗收與文件

端到端測試、評測結果、README、Trace 匯出、與學士後團隊測試 API 串接。

11/13

週五

交件日

交付可執行原型、程式碼、文件、Agent 評測資料與展示成果。

## 六、關於 LLM，這週應該做到什麼程度？

這部分我會建議你們採取兩層設計：

第一層：固定資料集 + 確定性分析（必要）

先將公開課綱、競賽簡章與教師專長整理成結構化 JSON。三個 Agent 可以直接從資料庫讀取，不需要每次都呼叫 LLM，確保 MVP 可穩定展示。

第二層：LLM 資料解析（有餘力再加入）

讓 LLM 接收原始課綱或簡章，將非結構化文字轉換成標準 JSON，再由 Pydantic 驗證、保留來源後存入資料庫。這也與原提案「LLM 負責文件解析、規則負責決策」的方向一致。

要注意，若只有第一層，則需要在簡報中如實說明目前採用的是預先整理的結構化資料與規則式 Agent Workflow，而不是宣稱已完成完整的即時 LLM 文件分析。

## 七、這次我最建議你們優先完成的功能

以 11/13 的期限來看，我會將成果分為兩個層級：

| 優先級         | 交付成果                                               |
| ----------- | -------------------------------------------------- |
| P0（一定完成）    | 三個 Agent 可執行、FastAPI、基本資料庫、Agent Workflow、Trace、測試 |
| P1（盡可能完成）   | LLM 課綱／簡章解析、動態補查、完整比賽難度分析、進階推薦解釋                   |
| P2（決賽展示後擴充） | 學校資料即時同步、全自動多輪探索、正式權限與通知服務                         |

我認為這份 Python 版本的系統規格可以作為你們碩士班三人的開發基準。

不過，有一個需要今天就和學士後隊員確認的整合點：隊友媒合到底是獨立後端服務，還是直接整合進你們的 FastAPI？兩種方式都可行，但必須先確定資料契約與 API 負責人。這不影響三個 Agent 各自開始實作，卻會直接影響週三的整合效率。

最後，我會建議你們把 Swagger `/docs` 作為最低限度可操作後端原型，這樣即使前端尚未完成，也可以獨立展示完整的 Agent 工作流程與執行紀錄，避免後端交付受到其他隊員進度影響。