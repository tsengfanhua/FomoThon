"""HWU category output adapter. No crawling, inference, or URI normalization."""

from dataclasses import dataclass, field
import json
from pathlib import Path
from competition_agent.db.repository import CompetitionRepository


@dataclass
class ImportReport:
    inserted: int = 0
    duplicates: int = 0
    rejected: list[dict] = field(default_factory=list)


def source_from_item(item: dict) -> dict:
    if not isinstance(item, dict):
        raise ValueError("Item must be an object")
    if item.get("error") is not None:
        raise ValueError(f"Crawler error: {item['error']}")
    result = {}
    for key in ("source_url", "source_school", "title", "clean_content"):
        value = item.get(key)
        if not isinstance(value, str) or (key == "source_url" and not value.strip()):
            raise ValueError(f"Invalid or missing {key}")
        result[key] = value
    date = item.get("published_at")
    if date is not None and not isinstance(date, str):
        raise ValueError("published_at must be text or null")
    result["published_at"] = date
    return result


def import_category_json(path: str | Path, repository: CompetitionRepository) -> ImportReport:
    """Import successful items individually; report rejected item indices (zero based).

    Database errors propagate, preserving previously committed items. Re-running is safe.
    Input summary counters describe crawling, not this import, and are not trusted as counts.
    """
    payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise ValueError("Expected category output object containing items array")
    report = ImportReport()
    for index, item in enumerate(payload["items"]):
        try:
            source = source_from_item(item)
        except ValueError as exc:
            report.rejected.append({"index": index, "reason": str(exc)})
            continue
        _, inserted = repository.add_source(**source)
        if inserted:
            report.inserted += 1
        else:
            report.duplicates += 1
    return report
