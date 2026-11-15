"""產生人工複核表：兩份內容相同的 Excel（兩位複核者各填一份）與一份對照檔。

對照檔 key/audit_key.json 記下每個編號對應的資料與各做法的採用結果，放在子資料夾裡：
複核者不需要、也不應該打開，把表交給別人時只給 Excel 檔，不要連 key/ 一起給。
輸出預設放在 data/private/audit/（不進版本控制）：證據文字含論文與計畫標題，仍可能辨識出教師，
對照檔裡也有教師的代號。

已經存在的複核檔案不會被覆蓋；加 --force 重抽時，舊的檔案（含填過的表、裁決表與報告）
先整批搬到 backup-時間/ 底下。每次抽樣有一個批次代碼，寫進對照檔與每一份表，
報告程式據此拒絕把不同批的表混在一起算。
"""

import argparse
import hashlib
import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from shared.audit.sampling import (
    LinkItem, PairItem, load_links, load_pairs, name_pattern, names_found, sample_links, sample_pairs)
from shared.audit.workbook import write_workbook
from shared.esco.similarity import CANDIDATE_THRESHOLD, CANDIDATE_TOP_K, THRESHOLD, TOP_K, last_run

WORKBOOKS = ("audit_A.xlsx", "audit_B.xlsx")
ADJUDICATION_FILE = "audit_adjudication.xlsx"
REPORT_FILE = "REPORT.md"
KEY_FILE = "key/audit_key.json"
DEFAULT_PER_SOURCE = 100
DEFAULT_SEED = 42
BATCH_CHARS = 12


def link_record(item: LinkItem) -> dict:
    return {key: value for key, value in asdict(item).items() if key != "sample_id"}


def pair_record(item: PairItem) -> dict:
    return {"a": item.a_uri, "b": item.b_uri, "a_skill": item.a, "b_skill": item.b, "similarity": item.similarity,
            "by_threshold": item.by_threshold, "by_judge": item.by_judge, "relation": item.relation}


def batch_code(links: list[LinkItem], pairs: list[PairItem]) -> str:
    """這一批樣本的指紋：編號與它對應的內容一變，代碼就不同。"""
    parts = [f"{item.sample_id}|{item.source}|{item.entity_id}|{item.concept_uri}|{item.evidence}" for item in links]
    parts += [f"{item.sample_id}|{item.a_uri}|{item.b_uri}" for item in pairs]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:BATCH_CHARS]


def _set_aside(out_dir: Path, names: list[str]) -> Path:
    """把舊的複核檔案整批搬進備份資料夾（不刪除任何填過的內容）。"""
    backup = out_dir / f"backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    for name in names:
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        (out_dir / name).rename(target)
    return backup


def build_audit(esco_db: Path, hub_db: Path, course_db: Path, out_dir: Path, per_source: int = DEFAULT_PER_SOURCE,
                pair_limit: int = 0, seed: int = DEFAULT_SEED, force: bool = False) -> dict:
    """抽樣並寫出複核表；回傳各部分的筆數。

    檔案已存在且沒有 force 時丟出 FileExistsError；文字裡還有教師姓名時丟出 ValueError，不寫任何檔案。
    """
    out_dir = Path(out_dir)
    existing = [name for name in (*WORKBOOKS, KEY_FILE, ADJUDICATION_FILE, REPORT_FILE) if (out_dir / name).exists()]
    if existing and not force:
        raise FileExistsError(f"{out_dir} 已經有複核檔案（{'、'.join(existing)}）；確定要重抽請加 --force（舊檔會先備份）")
    population = load_links(hub_db, course_db, esco_db)
    links = sample_links(population, per_source, seed)
    leaked = names_found(links, name_pattern(hub_db))
    if leaked:
        raise ValueError(f"抽到的文字裡仍有教師姓名（{'、'.join(leaked[:5])}），已中止，沒有寫出任何檔案")
    candidates = load_pairs(esco_db, hub_db, course_db)
    pairs = sample_pairs(candidates, pair_limit, seed)
    batch = batch_code(links, pairs)
    backup = _set_aside(out_dir, existing) if existing else None
    (out_dir / KEY_FILE).parent.mkdir(parents=True, exist_ok=True)
    for name in WORKBOOKS:
        write_workbook(out_dir / name, links, pairs, batch=batch)
    key = {
        "batch": batch, "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "seed": seed,
        "per_source": per_source, "pair_limit": pair_limit,
        "population": {**{source: len(rows) for source, rows in population.items()}, "pairs": len(candidates)},
        "settings": {"threshold": THRESHOLD, "top_k": TOP_K, "candidate_threshold": CANDIDATE_THRESHOLD,
                     "candidate_top_k": CANDIDATE_TOP_K, "similarity_run": last_run(esco_db)},
        "links": {item.sample_id: link_record(item) for item in links},
        "pairs": {item.sample_id: pair_record(item) for item in pairs},
    }
    (out_dir / KEY_FILE).write_text(json.dumps(key, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"batch": batch, "links": len(links), "pairs": len(pairs), "population": key["population"],
            "backup": str(backup) if backup else None, "workbooks": [str(out_dir / name) for name in WORKBOOKS]}


def main() -> None:
    from shared.hub.batch import emit_summary

    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="產生技能對應與相近配對的人工複核表（只讀資料庫，不呼叫外部服務）")
    parser.add_argument("--esco-db", type=Path, default=root / "data/shared/esco_skills.sqlite")
    parser.add_argument("--hub-db", type=Path, default=root / "data/shared/skill_hub.sqlite")
    parser.add_argument("--course-db", type=Path, default=root / "course-agent/data/processed/course_index.sqlite")
    parser.add_argument("--out-dir", type=Path, default=root / "data/private/audit")
    parser.add_argument("--per-source", type=int, default=DEFAULT_PER_SOURCE, help="課程、教師、比賽各抽幾筆對應")
    parser.add_argument("--pairs", type=int, default=0, help="相近配對抽幾組；0 表示全部候選")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--force", action="store_true", help="重新抽樣；舊的複核檔案會先搬到 backup-時間/ 底下")
    args = parser.parse_args()
    if args.per_source < 1 or args.pairs < 0:
        parser.error("--per-source 至少為 1，--pairs 不可為負數")
    try:
        summary = build_audit(args.esco_db, args.hub_db, args.course_db, args.out_dir, args.per_source,
                              args.pairs, args.seed, args.force)
    except (FileExistsError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    emit_summary(summary)


if __name__ == "__main__":
    main()
