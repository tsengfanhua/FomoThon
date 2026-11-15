"""爬取最新比賽資訊，判斷參賽條件與技能需求，寫入跨 Agent 的技能中樞資料庫。

會對外抓取公開網頁並呼叫外部模型（可能產生費用）。在 competition-agent 目錄執行：

    python -m scripts.crawl_competitions --limit 10              # 獎金獵人最近更新、尚未截止的比賽
    python -m scripts.crawl_competitions --url https://example.org/contest   # 指定的官方比賽頁
    python -m scripts.crawl_competitions --limit 10 --export-json out.json   # 另存成來源匯入格式

已有確定結果的比賽會略過（--force 可重跑）。最後在標準輸出印出一行 JSON 摘要。

--export-json 把這次抓到的比賽另存成 competition_agent.adapters.crawler_json 讀得懂的格式
（items 內含 source_url、source_school、title、clean_content、published_at），
可以接著用 import_category_json 匯入本 Agent 的資料庫，走人工審核流程。
"""

import argparse
import json
import logging
import os
import sys
from datetime import date
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from competition_agent.hub.crawler import (  # noqa: E402
    CrawlError, Crawler, RawCompetition, fetch_competition, list_bhuntr_latest)
from competition_agent.hub.requirements import analyze_competition, is_out_of_scope  # noqa: E402
from shared.esco.labels_zh import translate_missing, used_uris  # noqa: E402
from shared.esco.pair_judge import build_judge  # noqa: E402
from shared.esco.repository import EscoRepository  # noqa: E402
from shared.esco.similarity import OpenAIEmbedder, update_similarity  # noqa: E402
from shared.hub import db as hub_db  # noqa: E402
from shared.hub.batch import configure_logging, emit_summary, run_batch  # noqa: E402
from shared.llm import OpenAIJsonClient  # noqa: E402

logger = logging.getLogger(__name__)
# 簡章長、比賽數量少，預設用較強的模型（實測技能對應明顯較準）。
# 優先順序：--model > COMPETITION_LLM_MODEL > SKILL_LLM_MODEL（三個 Agent 共用的設定）> 這個預設值
DEFAULT_COMPETITION_MODEL = "gpt-4.1"
# 每找 1 筆尚未截止的比賽，最多願意多抓幾頁；避免為了湊數量對來源網站發出過多請求
PAGES_PER_WANTED = 4
# 指定主題關鍵字時命中率較低，放寬到這個上限（每秒一頁）
MAX_PAGES_WITH_KEYWORDS = 400


def matches_keywords(raw: RawCompetition, keywords: list[str]) -> bool:
    """比賽名稱或來源網站的標籤含任一關鍵字（不分大小寫）；沒有指定關鍵字時一律通過。"""
    haystack = f"{raw.name} {' '.join(raw.keywords)}".casefold()
    return not keywords or any(keyword.casefold() in haystack for keyword in keywords)


def collect(crawler: Crawler, urls: list[str], wanted: int, today: str, skip: set[str],
            keywords: list[str] | None = None) -> tuple[list[RawCompetition], dict]:
    """逐頁抓取直到湊滿 wanted 筆可分析的比賽；回傳（比賽、各種略過原因的筆數）。

    stats["reasons"] 列出沒有進入分析的原因代碼（不重複），讓呼叫端能告訴使用者為什麼沒有結果。
    """
    stats = {"fetched": 0, "skipped_closed": 0, "skipped_scope": 0, "skipped_topic": 0, "skipped_known": 0, "fetch_failed": 0}
    reasons: list[str] = []
    found: list[RawCompetition] = []
    for url in urls:
        if len(found) >= wanted:
            break
        try:
            raw = fetch_competition(crawler, url)
        except CrawlError as error:
            logger.warning("抓取失敗（%s）：%s", error.reason, url)
            stats["fetch_failed"] += 1
            reasons.append(error.reason)
            continue
        except Exception:  # 單一頁面的任何意外都只影響那一頁，前面抓到的不能白費
            logger.exception("抓取時發生未預期的錯誤：%s", url)
            stats["fetch_failed"] += 1
            reasons.append("unexpected_error")
            continue
        stats["fetched"] += 1
        if raw.competition_id in skip:
            stats["skipped_known"] += 1
            reasons.append("already_analyzed")
        elif raw.deadline and raw.deadline < today:
            stats["skipped_closed"] += 1
            reasons.append("closed")
        elif is_out_of_scope(raw):
            stats["skipped_scope"] += 1
            reasons.append("out_of_scope")
        elif not matches_keywords(raw, keywords or []):
            stats["skipped_topic"] += 1
        else:
            found.append(raw)
    return found, {**stats, "reasons": list(dict.fromkeys(reasons))}


def export_items(competitions: list[RawCompetition]) -> dict:
    """轉成 competition_agent.adapters.crawler_json 的來源匯入格式；欄位名稱以該轉接器為準。"""
    return {"items": [{"source_url": raw.source_url, "source_school": raw.source_site, "title": raw.name,
                       "clean_content": raw.text, "published_at": raw.start_date} for raw in competitions],
            "summary": {"scraped_count": len(competitions)}}


def main() -> None:
    parser = argparse.ArgumentParser(description="比賽爬蟲 → 條件與 ESCO 技能需求（會對外連線並呼叫模型）")
    parser.add_argument("--url", action="append", default=[], help="指定比賽頁網址（https，可重複）")
    parser.add_argument("--limit", type=int, default=8, help="未指定 --url 時，要分析幾筆最新比賽")
    parser.add_argument("--keywords", default="", help="只保留名稱或標籤含這些關鍵字的比賽（逗號分隔）")
    parser.add_argument("--hub-db", type=Path, default=ROOT / "data/shared/skill_hub.sqlite")
    parser.add_argument("--esco-db", type=Path, default=ROOT / "data/shared/esco_skills.sqlite")
    parser.add_argument("--course-db", type=Path, default=ROOT / "course-agent/data/processed/course_index.sqlite",
                        help="課程資料庫；用來讓比賽需求優先對到校內已使用的技能")
    parser.add_argument("--model")
    parser.add_argument("--today", default=date.today().isoformat(), help="判斷是否截止的日期（YYYY-MM-DD）")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--export-json", type=Path, help="把抓到的比賽另存成來源匯入格式（給 crawler_json 轉接器）")
    args = parser.parse_args()
    configure_logging()
    if not 1 <= args.limit <= 50:
        parser.error("--limit 必須在 1 到 50 之間")

    hub_db.initialize(args.hub_db)
    skip = set() if args.force else hub_db.finished_ids(args.hub_db, "competitions", "competition_id")
    # 先確認模型可用再對外抓取：沒有金鑰時不該先打別人的網站才失敗
    try:
        client = OpenAIJsonClient(args.model or os.environ.get("COMPETITION_LLM_MODEL")
                                  or os.environ.get("SKILL_LLM_MODEL") or DEFAULT_COMPETITION_MODEL)
    except RuntimeError:
        emit_summary({"entity": "competition", "error": "missing_api_key"})
        raise SystemExit(1) from None
    with httpx.Client() as http:
        crawler = Crawler(http)
        try:
            keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
            pages = MAX_PAGES_WITH_KEYWORDS if keywords else args.limit * PAGES_PER_WANTED
            urls = args.url or list_bhuntr_latest(crawler, int(args.today[:4]), pages)
        except CrawlError as error:
            emit_summary({"entity": "competition", "error": "source_unavailable", "detail": error.reason})
            raise SystemExit(1) from None
        wanted = len(args.url) if args.url else args.limit
        competitions, stats = collect(crawler, urls, wanted, args.today, skip, None if args.url else keywords)
    if args.export_json and competitions:
        args.export_json.write_text(json.dumps(export_items(competitions), ensure_ascii=False, indent=2), encoding="utf-8")
    if not competitions:
        emit_summary({"entity": "competition", "total": 0, **stats, "ids": []})
        return
    repository = EscoRepository(args.esco_db)
    # 校內課程與教師（以及先前分析過的比賽）已使用的技能：新的比賽需求優先對到同一組詞彙
    campus_skills = frozenset(used_uris(args.hub_db, args.course_db))
    logger.info("待分析比賽 %d 筆（模型 %s；對齊 %d 項已使用的技能）", len(competitions), client.model, len(campus_skills))

    def analyze(raw: RawCompetition) -> dict:
        record, skills = analyze_competition(raw, repository, client, campus_skills)
        return {"status": record["status"], "record": record, "skills": skills}

    def save(raw: RawCompetition, result: dict) -> None:
        hub_db.save_competition(args.hub_db, {**result["record"], "model": client.model}, result["skills"])

    summary = run_batch(competitions, analyze, save, workers=args.workers, label=lambda raw: raw.competition_id)
    # 收尾：替新出現的技能補上中文名稱，並重算比賽需求與校內技能的語意相近配對（兩者失敗都不影響結果）
    labels = translate_missing(args.esco_db, client, used_uris(args.hub_db, None), client.model)
    try:
        similar = update_similarity(args.esco_db, args.hub_db, args.course_db, OpenAIEmbedder(), build_judge())
    except Exception:
        logger.exception("無法建立向量或判斷用的模型用戶端，略過語意相近技能的計算")
        similar = {"similar_pairs": 0}
    emit_summary({"entity": "competition", "model": client.model, **summary, **stats,
                  "labels_translated": labels["translated"], "similar_pairs": similar["similar_pairs"],
                  "ids": [raw.competition_id for raw in competitions]})


if __name__ == "__main__":
    main()
