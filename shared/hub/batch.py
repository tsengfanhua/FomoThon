"""批次分析的共用執行器：模型呼叫平行、資料庫寫入循序。"""

import json
import logging
import sys
from collections import Counter
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)


def run_batch(items: Iterable, analyze: Callable, save: Callable, *, workers: int = 8,
              label: Callable = str) -> dict:
    """analyze(item) 在工作執行緒中執行（只做讀取與模型呼叫）；save(item, result) 在主執行緒執行。

    單筆失敗不影響其他筆；回傳各狀態的筆數。SQLite 只在主執行緒寫入，避免鎖定衝突。
    """
    items = list(items)
    counts: Counter = Counter()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(analyze, item): item for item in items}
        for done, future in enumerate(as_completed(futures), 1):
            item = futures[future]
            try:
                result = future.result()
                save(item, result)
                counts[result.get("status", "unknown")] += 1
            except Exception:
                logger.exception("處理失敗：%s", label(item))
                counts["errors"] += 1  # 不叫 error：摘要裡的 error 欄位保留給「整個工作失敗」的原因代碼
            if done % 20 == 0 or done == len(items):
                logger.info("進度 %d/%d %s", done, len(items), dict(counts))
    return {"total": len(items), **counts}


def configure_logging() -> None:
    """日誌寫到 stderr，stdout 留給最後的 JSON 摘要（給呼叫端程式解析）。"""
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)


def emit_summary(summary: dict) -> None:
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
