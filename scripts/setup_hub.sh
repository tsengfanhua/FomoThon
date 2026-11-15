#!/usr/bin/env bash
# 建立「技能串接」需要的資料：共用 ESCO 目錄 → 課程索引 → 三個 Agent 的分析結果。
# 可重複執行：已有確定結果的教師、課程、比賽會略過。分析步驟會呼叫外部模型（需要 OPENAI_API_KEY，會產生費用）。
#
#   scripts/setup_hub.sh                 # 只建立不花錢的基礎資料（ESCO 目錄、技能關聯、課程索引）
#   scripts/setup_hub.sh --analyze       # 另外執行三個 Agent 的分析（預設規模見下方變數）
#
# 可用環境變數調整規模：ADVISOR_LIMIT、COURSE_LIMIT、COMPETITION_LIMIT、COURSE_TERM（例如 114-2）、HUB_PYTHON
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${HUB_PYTHON:-$ROOT/.venv/bin/python}"
ESCO_DB="$ROOT/data/shared/esco_skills.sqlite"
COURSE_DB="$ROOT/course-agent/data/processed/course_index.sqlite"
SYLLABUS_DIR="${SYLLABUS_DIR:-$ROOT/course-agent/data/開課資料114}"
ESCO_DATASET="${ESCO_DATASET:-$ROOT/data/ESCO dataset - v1.2.1 - classification - en - csv}"
COURSE_TERM="${COURSE_TERM:-114-2}"

if [[ ! -x "$PYTHON" ]]; then
  echo "找不到 Python：$PYTHON" >&2
  echo "請先建立虛擬環境並安裝相依套件（見 README「環境」），或以 HUB_PYTHON 指定 Python 路徑。" >&2
  exit 1
fi

cd "$ROOT"
echo "== 1/3 共用 ESCO 技能目錄與技能關聯 =="
"$PYTHON" -m shared.esco.init_db --csv course-agent/data/skills_en.csv --db "$ESCO_DB"
"$PYTHON" -m shared.esco.relations --db "$ESCO_DB" --dataset-dir "$ESCO_DATASET"

echo "== 2/3 課程索引（課綱）=="
if [[ -f "$COURSE_DB" ]]; then
  echo "課程索引已存在，略過（要重建請先刪除 $COURSE_DB）"
else
  if [[ ! -d "$SYLLABUS_DIR" ]]; then
    echo "找不到課綱資料夾：$SYLLABUS_DIR（可用 SYLLABUS_DIR 指定）" >&2
    exit 1
  fi
  terms="$(cd "$SYLLABUS_DIR" && { ls -d ./*教學大綱 2>/dev/null || true; } | sed -e 's#^\./##' -e 's#教學大綱$##' | paste -sd, -)"
  if [[ -z "$terms" ]]; then
    echo "課綱資料夾裡沒有「學年-學期教學大綱」子資料夾（例如 114-2教學大綱）：$SYLLABUS_DIR" >&2
    exit 1
  fi
  (cd course-agent && "$PYTHON" -m scripts.init_course_db --data-dir "$SYLLABUS_DIR" --db "$COURSE_DB" --esco-db "$ESCO_DB" --terms "$terms")
fi

if [[ "${1:-}" != "--analyze" ]]; then
  echo "== 3/3 略過分析（加上 --analyze 才會呼叫模型）=="
  exit 0
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "缺少 OPENAI_API_KEY 環境變數，無法執行分析。" >&2
  exit 1
fi

echo "== 3/3 三個 Agent 的分析（會呼叫外部模型）=="
echo "-- 教師 Agent：教師 profile → ESCO 技能"
(cd advisor-agent && "$PYTHON" -m scripts.analyze_advisor_skills ${ADVISOR_LIMIT:+--limit "$ADVISOR_LIMIT"})
echo "-- 課程 Agent：課綱 → ESCO 技能（$COURSE_TERM，每個課名取一班代表）"
(cd course-agent && "$PYTHON" -m scripts.analyze_course_skills --year "${COURSE_TERM%-*}" --semester "${COURSE_TERM#*-}" ${COURSE_LIMIT:+--limit "$COURSE_LIMIT"})
echo "-- 競賽 Agent：爬取最新比賽 → 條件與技能需求"
(cd competition-agent && "$PYTHON" -m scripts.crawl_competitions --limit "${COMPETITION_LIMIT:-20}")
echo "-- 共用：技能中文名稱與語意相近配對"
"$PYTHON" -m shared.esco.labels_zh
"$PYTHON" -m shared.esco.similarity
echo "完成。執行 scripts/start_web.sh 啟動網站。"
