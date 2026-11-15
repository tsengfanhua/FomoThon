"""Conservative, versioned phrase groups; no network or model dependencies."""
import hashlib
import json
import re

VERSION = "hwu-rules-1"
SCHOOL = "醒吾科技大學"
CATEGORIES = {"competition_call", "competition_update", "competition_result", "non_competition", "needs_review"}
PATTERNS = {
    "competition": r"競賽|比賽|挑戰賽|黑客松|大賽",
    "call": r"報名|徵件|徵求參賽|收件|截稿",
    "support": r"參賽資格|參賽對象|截止|期限|即日起|報名時間|報名日期|報名及初賽|截稿日期|繳交",
    "result": r"入選名單|得獎名單|獲獎名單|錄取名單|評選結果|決賽結果|共錄取|名單如下",
    "update": r"延期|延長.{0,8}(?:報名|截止)|更正|規則調整|補充通知|再次行文|重新公告",
    "event": r"工作坊|論壇|講座|研討會|行政公告|停水|停電",
    "event_support": r"講師|議程|活動時間|舉辦日期|報名|辦理|舉辦|通知",
    "nomination": r"提名|候選人",
}


def content_hash(source):
    values = [source[key] for key in ("source_school", "title", "clean_content")]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False).encode("utf-8")).hexdigest()


def classify(source):
    if source["source_school"] != SCHOOL:
        raise ValueError("Only HWU sources are supported")
    title, body = source["title"], source["clean_content"]
    evidence = []
    hits = {name: [] for name in PATTERNS}
    for field, text in (("title", title), ("clean_content", body)):
        for segment in re.split(r"[。；\n]", text):
            for signal, pattern in PATTERNS.items():
                match = re.search(pattern, segment)
                if not match:
                    continue
                # Future results and historical references are not current result evidence.
                if signal == "result" and re.search(r"預計|將於|將公布|將公告|歷屆|往年", segment):
                    continue
                item = {"rule_id": signal, "field": field, "quote": segment,
                        "matched": match.group(), "reason": f"Matched {signal} phrase"}
                hits[signal].append(item)
                evidence.append(item)
    comp = bool(hits["competition"])
    # Different references to one event (e.g. its rules and project office) are not two events.
    pairs = re.findall(r"[「『]([^」』]+)[」』]\s*(?:及|與|和|、)\s*[「『]([^」』]+)[」』]", title + "\n" + body)
    multi = any(all(re.search(PATTERNS["competition"], name) for name in pair) for pair in pairs)
    multi = multi or bool(re.search(r"(?:兩|多|2)項競賽|競賽.{0,20}(?:及|與).{0,20}競賽", title + "\n" + body))
    mixed = comp and bool(re.search(PATTERNS["event"], title))
    mixed = mixed or any(
        (re.search(PATTERNS["competition"], a) and re.search(PATTERNS["event"], b))
        or (re.search(PATTERNS["event"], a) and re.search(PATTERNS["competition"], b))
        for a, b in pairs
    )
    result = bool(hits["result"])
    update = bool(hits["update"])
    call = bool(hits["call"] and hits["support"])
    if multi or mixed:
        category, reason = "needs_review", "Multiple competitions or independent competition/activity mixture"
    elif comp and result and update:
        category, reason = "needs_review", "Conflicting result and update signals"
    elif comp and result:
        # Explicit result title dominates historical registration references in the body.
        if call and not any(e["field"] == "title" for e in hits["result"]):
            category, reason = "needs_review", "Result and call signals without a clear result title"
        else:
            category, reason = "competition_result", "Competition with published selection/result evidence"
    elif comp and update:
        category, reason = "competition_update", "Explicit amendment or republication in competition context"
    elif comp and call:
        category, reason = "competition_call", "Competition context plus submission signal and supporting requirement"
    elif not comp and hits["event"] and hits["event_support"] and not hits["nomination"]:
        category, reason = "non_competition", "Explicit ordinary activity with no competition signals"
    else:
        category, reason = "needs_review", "Insufficient evidence or nomination award outside current scope"
    evidence.append({"rule_id": "decision", "reason": reason, "multiple_competitions": multi})
    return {"category": category, "evidence": evidence, "rule_version": VERSION}
