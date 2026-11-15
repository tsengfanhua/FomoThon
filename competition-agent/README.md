# Competition Agent database core

Python 3.10+, standard library only at runtime. Run offline tests from repository root:

```powershell
python -m unittest discover -s agents/competition_agent/tests -v
python -m unittest tests.test_hwu_crawler_offline tests.test_hwu_category_offline -v
```

For source-checkout usage set `PYTHONPATH` to `agents/competition_agent/src`, or install
this package with your environment's normal local package workflow. No installation is
required for the test command above.

```python
from competition_agent.db.connection import connect, initialize
from competition_agent.db.repository import CompetitionRepository
from competition_agent.adapters.crawler_json import import_category_json

connection = connect("competition.sqlite3")
try:
    initialize(connection)
    repository = CompetitionRepository(connection)
    report = import_category_json("data/test_output_category_4934.json", repository)
    print(report)
finally:
    connection.close()
```

This imports sources only. By default skill writes fail with `UNAVAILABLE`. When the
real shared repository is available, supply
`CompetitionRepository(connection, SkillUriValidator(shared_esco_repository))` from
`competition_agent.skills.validation`. The shared repository is read-only and must
return a record containing the exact requested concept_uri, or None when absent.
Mock ESCO records exist only in tests. See `docs/data-contract.md` for all interfaces,
transaction boundaries, limitations and the executable schema location.

## Phase 2 review workflow

`initialize` upgrades existing v1 files to v2 transactionally. Classification adds no
competitions or skills. Run it only for imported HWU sources:

```python
from competition_agent.classification.service import ClassificationService

service = ClassificationService(connection)
service.classify_hwu_sources()
pending = service.list_pending_reviews()
# Present original text and evidence to a HUMAN. Only after their explicit decision:
row = service.confirm_classification(
    source_id, expected_revision=reviewed_revision,
    category=human_category, reviewer=human_name, note=human_reason,
)
# A confirmed call can create an explicitly named/dated competition:
competition_id = service.create_competition_from_review(
    source_id, expected_revision=row["revision"],
    competition_name=human_formal_name, edition=human_edition,
    name_evidence=human_name_evidence, reviewer=human_name,
)
```

The variables beginning with `human_` are user input, not automatically derived values.
Results/updates use `link_reviewed_source` with an explicitly selected existing ID,
edition, note, reviewer and current expected_revision. No automatic merging by name.
On ReviewConflict, reload and review the current source/revision. Existing confirmations
are preserved when source content changes, but marked stale/pending. Existing links do
not imply current approval; inspect classification state. Repeated unchanged runs are
no-ops. See `docs/data-contract.md` for the one-source/one-competition MVP limitation.

## Local ESCO development database

The user-authorized local catalogue is separate from Competition SQLite. Its source is
the existing taxonomy CSV; no external catalogue is downloaded or copied into the
Competition database. From repository root in PowerShell:

```powershell
$env:PYTHONPATH = "agents/competition_agent/src"
python -m competition_agent.skills.import_esco data/reference/skill_taxonomy.csv agents/competition_agent/data/dev/esco.sqlite3
```

The destination MUST NOT exist. Repeating this command stops with a nonzero exit code,
leaves the existing file unchanged and cannot add duplicate rows. This intentionally
prioritizes the no-overwrite requirement over updating an existing catalogue. To rebuild,
choose another absent path explicitly. Invalid CSV/count fails before file creation;
an SQL failure rolls back and leaves the new file for inspection, not automatic replacement.
The whole `data/dev/` directory is Git-ignored, including SQLite sidecars.

```python
from competition_agent.skills.local_esco import LocalEscoRepository
from competition_agent.skills.validation import SkillUriValidator

with LocalEscoRepository("agents/competition_agent/data/dev/esco.sqlite3") as esco:
    candidates = esco.search("design", limit=20)
    if candidates:
        record = esco.get(candidates[0]["concept_uri"])
        result = SkillUriValidator(esco).validate(record["concept_uri"])
```

Reads use SQLite `mode=ro` and `query_only`. Missing files fail rather than creating an
empty database. Explicit injection is required; there is no automatic development
fallback. The caller keeps the ESCO repository open while the validator uses it.
Search is a deterministic English label/description substring query, not semantic
matching or Chinese translation. Default limit is 20, valid range 1–100; blank search
returns no results and SQL wildcard characters are treated literally.

## Offline skill proposals (schema v3)

`initialize` now upgrades Competition schema v1/v2 to v3 atomically. Existing Demo files
are NOT automatically opened or upgraded. This release adds two workflow tables and
does not alter the ESCO schema. All pipeline tests write only temporary SQLite files.

```python
from competition_agent.skills.proposals import SkillProposalService, SkillReviewService

# connection must be v3; esco is an explicitly supplied open LocalEscoRepository.
# offline_extractor implements SkillExtractor; fixed mocks live only in tests.
proposals = SkillProposalService(connection, esco)
run = proposals.extract(competition_id, source_id, offline_extractor)
pending = proposals.list_proposals(run["run_id"])
# After a HUMAN inspects the full source, exact quote, scope and ESCO definition:
reviews = SkillReviewService(connection, esco)
accepted = reviews.accept_skill_proposal(
    human_proposal_id, expected_revision=human_reviewed_revision,
    selected_concept_uri=human_selected_uri, importance=human_importance,
    reviewer=human_name, note=human_reason,
)
```

Do not accept automatically in a loop. FixedMockExtractor and synthetic announcements
exist only in tests. The real Yushow fixture returns zero proposals; its theme is not a
skill requirement. Only confirmed calls, explicit evidence and competition-wide scope
can be accepted. Group-specific claims remain proposals. Unknown Chinese vocabulary
requires controlled dictionary maintenance, not guessed English terms/ESCO IDs.

Repeated completed runs are cached; failed runs require an explicit retry. Source or
revision changes require fresh review. Use `reviews.refresh(proposal_id)` to observe
staleness; raw skill queries do not establish evidence freshness. Existing plain-text
evidence or importance conflicts require explicit reconciliation and are preserved.

See `docs/data-contract.md` for exact state, transaction and evidence contracts, and
`offline-skills-results.md` for verified real-zero and synthetic-positive test results.

## Read-only MCP server

See [MCP.md](MCP.md) for official SDK installation, Windows stdio startup/client
configuration and the three read-only query tools. Existing schema-v3 Competition and
ESCO paths are required; no API key, database initialization or extraction is used.

## Optional OpenAI extractor (disabled by default)

### Standalone smoke: default dry-run

Production retains `tiktoken-json-512-v1`, failing closed for unknown models. Only
`smoke_openai` explicitly injects `utf8-budget-v1`: canonical full-request JSON UTF-8
bytes + 1,024 (sorted keys, compact separators, no ASCII escaping). It allows only
fixed system/user text and the existing schema, without tools, history or media.
This is an engineering estimate, NOT exact tokens or a hard billing ceiling. Strategy
version enters extractor version; proposal services reject the smoke byte strategy.

From repository root, dry-run needs no key and creates no ledger or SQLite:

```powershell
$py = 'C:\Users\user\AppData\Local\Python\bin\python.exe'
$env:PYTHONPATH = "$PWD/agents/competition_agent/src"
& $py -B -m competition_agent.skills.smoke_openai
```

**PAID REQUEST: only after separate explicit authorization.** The key must already
exist in the current environment. These future commands can incur API charges:

```powershell
$env:COMPETITION_ENABLE_OPENAI = '1'
$env:COMPETITION_OPENAI_MODEL = 'gpt-6-luna'
$env:COMPETITION_OPENAI_MAX_REQUESTS = '1'
$env:COMPETITION_OPENAI_BUDGET_USD = '0.002'
& $py -B -m competition_agent.skills.smoke_openai --execute-paid-request
```

Fixed limits: Luna/none, 6,000 estimated input, 2,000 output, 30 seconds, SDK retries 0.
Standard is explicitly `service_tier=default`; response tier and usage must be present
and valid. A response mismatch can already have incurred cost and is not retried.
Only PId 108400 JSON is read; no SQLite is opened and no skills are accepted. Nonzero
validated claims are retained in ignored `pending-review.json` for manual inspection;
console output contains only safe counts/status/error codes, never raw model output.

The fixed absolute ledger is resolved from this checkout under
`agents/competition_agent/data/dev/openai-smoke/`, with no CLI directory override.
One USD 0.00175 reservation consumes the attempt, even after timeout/refusal or failed
result persistence. Never clear/rotate the ledger or copy the checkout to resend.
Inspect local ledger/provider usage manually and obtain new authorization for recovery.
Crash locks block further use. This is local single-session protection, not a global
account/distributed guarantee. No additional package is needed. The original live
unittest remains forcibly skipped. There is no automatic tokenizer fallback.

`skills.openai_extractor.OpenAISkillExtractor` implements the same interface. Install
the optional `[openai]` dependency group only when preparing an authorized live run.
No SDK import or network operation occurs during construction. Existing offline mocks
and tests need neither the SDK nor a real credential.

The environment configuration requires ALL of `COMPETITION_ENABLE_OPENAI=1`,
`OPENAI_API_KEY`, `COMPETITION_OPENAI_MODEL`, `COMPETITION_OPENAI_MAX_REQUESTS` (positive
integer), and `COMPETITION_OPENAI_BUDGET_USD` (positive decimal). The default model is
`gpt-6-luna`, reasoning `none`; enabling via environment still requires explicitly naming
the model. An explicit `APIConfig` may also configure these limits; the key is always
read only from the environment. Never put credentials in scripts or fixtures.

Default limits: 6,000 estimated input tokens, 2,000 output tokens, 30-second SDK timeout,
zero SDK retries. Unknown local tokenizers fail closed. Input counting includes the
schema and prompt plus framing allowance; it is an estimate, not a server-side cap.
Actual usage above the configured caps blocks subsequent calls pending reconciliation.
No model fallback or automatic retry is performed. Custom models require reviewed rate
configuration through `APIConfig`.

Use one absolute `state_dir` under the Git-ignored `agents/competition_agent/data/dev/`
for all callers (the default relative path assumes repository-root execution).
An exclusive lock rejects overlapping sessions; concurrent workers, independent state
directories and distributed execution are unsupported. A crash lock requires manual
inspection before recovery. Do not delete or rotate the ledger to bypass limits.
`calls.jsonl` records hashes, reservations, safe error codes and usage only, never keys,
announcement text or raw provider responses. Each attempt reserves the full configured
token allowance before submission and is not refunded, including failed/time-out calls.
Default conservative rates reserve USD 0.00175 per attempt. Prices must be checked before
authorizing real use; this local estimate is not an account-wide billing guarantee.

Completed proposal runs remain the only result cache. The call ledger blocks resubmission
of an already submitted request, including when a response or subsequent DB write was
lost. Such failures require human reconciliation, not an automatic retry.
API work runs outside SQLite transactions; source, classification revision and ESCO
fingerprint are checked again before persistence. Human skill acceptance is unchanged.

Run offline tests using the existing test commands. `test_openai_extractor.py` injects
fixed responses/fake transports and blocks socket connections. Its real API smoke test
is unconditionally skipped; environment variables cannot enable it. A future separately
authorized live check requires explicitly changing that skip and reviewing budget,
dependencies/tokenizer and ledger first. This release made no real API requests.

## 跨 Agent 技能串接：比賽爬蟲與簡章分析（`competition_agent.hub`）

本套件的核心不爬蟲，只匯入別的爬蟲產出的 JSON。`competition_agent.hub` 補上「爬取最新比賽 → 判斷需要什麼條件、需要什麼技能」，
供整合網站使用（見上層 [README](../README.md)）。它會對外連線並呼叫模型，需要 `httpx`、`pydantic` 與上層的 `shared/`；
核心模組不會匯入它，仍然只用標準函式庫。在 `competition-agent` 目錄執行：

```bash
python -m scripts.crawl_competitions --limit 10                    # 獎金獵人最近更新、尚未截止的比賽
python -m scripts.crawl_competitions --limit 20 --keywords "程式,AI,資料,創業"
python -m scripts.crawl_competitions --url https://example.org/contest   # 指定的官方比賽頁
python -m scripts.crawl_competitions --limit 10 --export-json out.json   # 另存成來源匯入格式
```

- `src/competition_agent/hub/crawler.py`：只抓 https 公開頁面；遵守 robots.txt（轉址後的網域也檢查，取不到時保守地不抓）；
  每秒最多一頁；連線前與每次轉址都拒絕本機、內網與保留位址；不接受壓縮回應、限制大小與下載時間；不保存主辦單位的聯絡電話與 Email。
  獎金獵人只讀主站的 sitemap 與比賽頁的 schema.org 結構化資料，不呼叫它不允許抓取的 API 子網域。
- `src/competition_agent/hub/requirements.py`：模型抽取參賽條件（是否限學生、學歷、隊伍人數、是否需要指導老師、截止日與其他條件），
  每個欄位都要附夠長的簡章原文、人數與日期的數字要出現在原文裡，**對不上的欄位改回未知**；技能需求交給共用的
  `shared/esco/mapper.py` 對應到 ESCO 技能並保留逐字證據。體育賽事與兒童比賽依名稱略過。
- 結果寫入 `data/shared/skill_hub.sqlite`，由整合網站讀取。這是模型自動對應、只經程式檢核的結果，**沒有經過本套件的人工審核流程**，
  不會寫入 `competition_skills`。
- **接到審核流程**：`--export-json` 把抓到的比賽存成 `adapters/crawler_json.py` 讀得懂的格式
  （`items` 內含 `source_url`、`source_school`、`title`、`clean_content`、`published_at`），可以接著用
  `import_category_json` 匯入來源，再走分類與人工審核。注意分類服務目前只處理 HWU 來源（`classify_hwu_sources`）。
- 模型以 `--model`、`COMPETITION_LLM_MODEL` 或 `SKILL_LLM_MODEL` 指定，預設 `gpt-4.1`；需要 `OPENAI_API_KEY`。
- 測試：`tests/test_crawler.py`、`tests/test_requirements.py`（pytest；不對外連線、不呼叫模型）。以 `python -m pytest` 可同時執行本套件原有的 unittest 測試。

限制：條件與技能由模型從簡章抽取，只保證「有原文可查」，不保證完整或理解正確；報名前請以主辦單位公告為準。
