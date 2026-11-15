"""讀回填好的複核表，計算一致性與精確率，並列出需要兩人討論裁決的項目。

流程：兩位複核者各自填完 → 執行本程式 → 判定不同的項目寫進 audit_adjudication.xlsx →
兩人討論後在該表填上最終判定 → 再執行一次，得到完整結果。只有一份表有填時也能算，但沒有一致性。

還沒有定論的項目（有人沒填、或意見不同尚未裁決）不計入精確率。意見不同的多半是難判的項目，
所以在全部裁決完之前，數字會偏高；報告會標成「暫時結果」，並列出那幾筆全錯到全對時的範圍。
表的批次代碼與對照檔不符時直接拒絕計算。REPORT.md 只有彙總數字，不含任何對象的識別資料。
"""

import argparse
import json
import logging
from pathlib import Path

from shared.audit import metrics
from shared.audit.build import ADJUDICATION_FILE, KEY_FILE, REPORT_FILE, WORKBOOKS
from shared.audit.sampling import SOURCES, LinkItem, PairItem
from shared.audit.workbook import SOURCE_NAMES, read_labels, write_workbook

logger = logging.getLogger(__name__)
KINDS = ("links", "pairs")
VARIANT_NAMES = {"threshold": "只看向量相似度門檻", "judge": "放寬門檻＋模型逐對判斷"}
MAX_INVALID_SHOWN = 20
CAVEATS = (
    "精確率回答的是「選出來的對不對」。漏掉哪些技能（召回率）在技能對應這邊沒有估計；"
    "相近配對的召回率只在這批候選的範圍內計算，候選不含已有 ESCO 官方關聯的配對。",
    "相近配對的判斷準則是看著同一批候選調整出來的，複核者的填寫說明也用同一套定義，"
    "所以兩種做法的比較對「模型逐對判斷」有利，不能當成它在新資料上的表現。",
    "信賴區間假設每一筆互相獨立。同一門課、同一位教師或同一場比賽可能被抽到好幾筆，實際的區間會再寬一些。",
)


def _read(path: Path, batch: str) -> dict:
    labels = read_labels(path)
    if labels["batch"] != batch:
        raise ValueError(f"{path.name} 的批次代碼（{labels['batch']}）與對照檔（{batch}）不同："
                         "這份表不是這一次抽樣產生的，不能一起計算")
    return labels


def _filled(labels: dict) -> bool:
    return any(labels["links"].values()) or any(labels["pairs"].values())


def _resolve(ids: list[str], first: dict, second: dict | None, decided: dict) -> tuple[dict[str, str], dict[str, tuple]]:
    """回傳（最終判定, 意見不同的項目 → 兩人各自的判定）。只有一位標註者時直接採用他的判定。"""
    if second is None:
        return {key: first[key] for key in ids if first.get(key)}, {}
    final: dict[str, str] = {}
    conflicts: dict[str, tuple] = {}
    for key in ids:
        label, other = first.get(key), second.get(key)
        if not label or not other:
            continue  # 還有人沒填
        if label == other:
            final[key] = label
        else:
            conflicts[key] = (label, other)
            if decided.get(key):
                final[key] = decided[key]
    return final, conflicts


def _progress(ids: list[str], final: dict, conflicts: dict) -> dict:
    pending = sum(1 for key in conflicts if key not in final)
    return {"sampled": len(ids), "settled": len(final), "pending": pending,
            "unfilled": len(ids) - len(final) - pending}


def _link_section(key: dict, final: dict[str, str], conflicts: dict, first: dict, second: dict | None) -> dict:
    by_source = {}
    for source in SOURCES:
        ids = [sample_id for sample_id, info in key["links"].items() if info["source"] == source]
        result = metrics.link_precision(final[sample_id] for sample_id in ids if sample_id in final)
        pending = sum(1 for sample_id in ids if sample_id in conflicts and sample_id not in final)
        by_source[source] = {**result, "pending": pending, "bounds": metrics.precision_bounds(
            result["strict"]["k"], result["strict"]["n"], pending)}
    return {"by_source": by_source,
            "weighted": {level: metrics.weighted_precision(by_source, key["population"], level)
                         for level in ("strict", "lenient")},
            "agreement": metrics.agreement(first, second) if second is not None else None,
            **_progress(list(key["links"]), final, conflicts)}


def _accepted(labels: dict[str, str | None]) -> dict[str, str]:
    return {key: ("採用" if label in metrics.PAIR_ACCEPTED else "不採用") for key, label in labels.items() if label}


def _pair_section(key: dict, final: dict[str, str], conflicts: dict, first: dict, second: dict | None) -> dict:
    truth = {sample_id: label in metrics.PAIR_ACCEPTED for sample_id, label in final.items()}
    flags = {"threshold": {sample_id: info["by_threshold"] for sample_id, info in key["pairs"].items()},
             "judge": {sample_id: info["by_judge"] for sample_id, info in key["pairs"].items()
                       if info["by_judge"] is not None}}
    usable = {name: values for name, values in flags.items() if values}
    # 兩種做法只在「兩邊都有結果」的同一批配對上比較，分母才一樣
    common = {sample_id: value for sample_id, value in truth.items()
              if all(sample_id in values for values in usable.values())}
    comparison = (metrics.paired_comparison(common, usable["threshold"], usable["judge"])
                  if len(usable) == 2 else None)
    return {"labelled": len(common), "accepted_by_humans": sum(common.values()),
            "variants": {name: metrics.variant_scores(common, values) for name, values in usable.items()},
            "comparison": comparison,
            "agreement": metrics.agreement(first, second) if second is not None else None,
            "agreement_binary": metrics.agreement(_accepted(first), _accepted(second)) if second is not None else None,
            **_progress(list(key["pairs"]), final, conflicts)}


def _write_adjudication(out_dir: Path, key: dict, conflicts: dict[str, tuple], previous: dict | None) -> None:
    """把意見不同的項目寫成裁決表；先前填的判定（即使不在選項內）與備註都帶回去。

    項目沒有增減時不重寫，保留使用者在表上做的任何標記。檔案正被開啟而寫不進去時只記錄，不中斷。
    """
    if previous and set(previous["links"]) | set(previous["pairs"]) == set(conflicts):
        return
    links = [LinkItem(sample_id=sample_id, **key["links"][sample_id]) for sample_id in sorted(conflicts)
             if sample_id in key["links"]]
    pairs = [PairItem(sample_id=sample_id, a_uri=info["a"], b_uri=info["b"], a=info["a_skill"], b=info["b_skill"],
                      similarity=info["similarity"], by_threshold=info["by_threshold"], by_judge=info["by_judge"],
                      relation=info["relation"])
             for sample_id, info in sorted(key["pairs"].items()) if sample_id in conflicts]
    try:
        write_workbook(out_dir / ADJUDICATION_FILE, links, pairs, batch=key["batch"], previous=conflicts,
                       decided=previous["raw"] if previous else None, notes=previous["notes"] if previous else None)
    except PermissionError:
        logger.warning("無法寫入 %s（可能正在 Excel 中開啟），這次沒有更新裁決表", ADJUDICATION_FILE)


def _percent(result: dict) -> str:
    if result["p"] is None:
        return "—"
    return f"{result['p']:.1%}（{result['k']}/{result['n']}；95% CI {result['low']:.1%}–{result['high']:.1%}）"


def _agreement_line(name: str, result: dict | None) -> str:
    if not result or not result["both"]:
        return f"- {name}：只有一位複核者，或還沒有兩人都填的項目。"
    kappa = "無法計算" if result["kappa"] is None else f"{result['kappa']:.3f}"
    return f"- {name}：兩人都填的 {result['both']} 筆中 {result['agree']} 筆相同（{result['raw']:.1%}），Cohen's κ = {kappa}。"


def _status_lines(report: dict, key: dict) -> list[str]:
    lines = [f"批次 {key['batch']}；抽樣種子 {key['seed']}；有填寫的複核者 {report['annotators']} 位。", "",
             "| 部分 | 抽樣 | 已有定論 | 待裁決 | 尚未填完 |", "| --- | --- | --- | --- | --- |"]
    lines += [f"| {name} | {part['sampled']} | {part['settled']} | {part['pending']} | {part['unfilled']} |"
              for name, part in (("技能對應", report["links"]), ("相近配對", report["pairs"]))]
    if report["provisional"]:
        lines += ["", "**暫時結果**：還有項目沒有定論，或只有一位複核者。沒有定論的項目不計入下面的精確率；"
                      "意見不同的多半是難判的項目，全部裁決完之前數字會偏高。"]
    return lines


def _link_lines(links: dict, key: dict) -> list[str]:
    lines = ["## 技能對應的精確率", "",
             "| 來源 | 母體筆數 | 嚴格（只算「正確」） | 寬鬆（含「粒度不符」） | 待裁決 | 嚴格的可能範圍 |",
             "| --- | --- | --- | --- | --- | --- |"]
    for source, result in links["by_source"].items():
        bounds = result["bounds"]
        span = "—" if not result["pending"] or bounds is None else f"{bounds[0]:.1%}–{bounds[1]:.1%}"
        lines.append(f"| {SOURCE_NAMES[source]} | {key['population'].get(source, 0)} | {_percent(result['strict'])} | "
                     f"{_percent(result['lenient'])} | {result['pending']} | {span} |")
    weighted = links["weighted"]
    lines += ["", "「嚴格的可能範圍」是待裁決的項目全部判為錯到全部判為正確時，嚴格精確率會落在哪裡。"]
    if weighted["strict"] is not None:
        lines += ["", f"依母體筆數加權的整體精確率（點估計）：嚴格 {weighted['strict']:.1%}、寬鬆 {weighted['lenient']:.1%}。"]
    else:
        lines += ["", "三個來源還沒有都有判定，先不計算整體精確率。"]
    return lines


def _pair_lines(pairs: dict, key: dict) -> list[str]:
    lines = ["## 相近配對：兩種做法在同一批人工判定上的比較", "",
             f"候選 {key['population']['pairs']} 組（不含已有 ESCO 官方關聯的配對）中，納入比較的有 {pairs['labelled']} 組，"
             f"人工判為「相同」或「上下位」的有 {pairs['accepted_by_humans']} 組。", "",
             "| 做法 | 精確率 | 召回率 | F1 |", "| --- | --- | --- | --- |"]
    lines += [f"| {VARIANT_NAMES[name]} | {_percent(scores['precision'])} | {_percent(scores['recall'])} | "
              f"{'—' if scores['f1'] is None else format(scores['f1'], '.3f')} |"
              for name, scores in pairs["variants"].items()]
    if "judge" not in pairs["variants"]:
        lines += ["", "最近一次計算相近配對時沒有使用模型逐對判斷，所以只有一種做法。"]
    comparison = pairs["comparison"]
    if comparison and comparison["p_value"] is not None:
        lines += ["", f"兩種做法判斷不同的配對中，只有門檻對的 {comparison['first_only']} 組、只有模型判斷對的 "
                      f"{comparison['second_only']} 組（精確 McNemar 檢定，雙尾 p = {comparison['p_value']:.3f}）。"]
    return lines


def _markdown(report: dict, key: dict) -> str:
    links, pairs = report["links"], report["pairs"]
    lines = ["# 人工複核結果", "", *_status_lines(report, key), "", *_link_lines(links, key), "",
             *_pair_lines(pairs, key), "", "## 複核者一致性", "",
             _agreement_line("技能對應（三種判定）", links["agreement"]),
             _agreement_line("相近配對（四種判定）", pairs["agreement"]),
             _agreement_line("相近配對（採用／不採用）", pairs["agreement_binary"])]
    if report["invalid"]:
        shown = "、".join(f"{item['file']} {item['id']}「{item['value']}」" for item in report["invalid"][:MAX_INVALID_SHOWN])
        lines += ["", "## 填了選項以外的值", "", f"共 {len(report['invalid'])} 格，已視為未填：{shown}。"]
    lines += ["", "## 讀這份結果時要注意", "", *(f"- {caveat}" for caveat in CAVEATS)]
    return "\n".join(lines) + "\n"


def build_report(out_dir: Path) -> dict:
    """讀回複核表並計算結果；同時更新裁決表與 REPORT.md。批次代碼不符時丟出 ValueError。"""
    out_dir = Path(out_dir)
    key = json.loads((out_dir / KEY_FILE).read_text(encoding="utf-8"))
    present = [name for name in WORKBOOKS if (out_dir / name).exists()]
    if not present:
        raise FileNotFoundError(f"{out_dir} 裡沒有複核表")
    sheets = {name: _read(out_dir / name, key["batch"]) for name in present}
    filled = [labels for labels in sheets.values() if _filled(labels)]   # 完全沒填的那一份不算複核者
    first = filled[0] if filled else next(iter(sheets.values()))
    second = filled[1] if len(filled) > 1 else None
    previous = _read(out_dir / ADJUDICATION_FILE, key["batch"]) if (out_dir / ADJUDICATION_FILE).exists() else None
    sections, conflicts_all = {}, {}
    for kind, section in zip(KINDS, (_link_section, _pair_section)):
        final, conflicts = _resolve(list(key[kind]), first[kind], second[kind] if second else None,
                                    previous[kind] if previous else {})
        sections[kind] = section(key, final, conflicts, first[kind], second[kind] if second else None)
        conflicts_all = {**conflicts_all, **conflicts}
    if conflicts_all:
        _write_adjudication(out_dir, key, conflicts_all, previous)
    files = {**sheets, **({ADJUDICATION_FILE: previous} if previous else {})}
    invalid = [{"file": name, "id": sample_id, "value": value}
               for name, labels in files.items() for sample_id, value in labels["invalid"]]
    unsettled = sum(sections[kind]["pending"] + sections[kind]["unfilled"] for kind in KINDS)
    report = {**sections, "batch": key["batch"], "annotators": len(filled), "invalid": invalid,
              "provisional": len(filled) < 2 or unsettled > 0}
    (out_dir / REPORT_FILE).write_text(_markdown(report, key), encoding="utf-8")
    return report


def main() -> None:
    from shared.hub.batch import configure_logging, emit_summary

    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="由填好的複核表計算精確率與一致性")
    parser.add_argument("--dir", type=Path, default=root / "data/private/audit")
    args = parser.parse_args()
    configure_logging()
    try:
        emit_summary(build_report(args.dir))
    except (FileNotFoundError, ValueError) as error:
        parser.exit(1, f"無法計算：{error}\n")


if __name__ == "__main__":
    main()
