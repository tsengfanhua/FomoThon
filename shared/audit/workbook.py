"""複核表（Excel）：寫出給標註者填寫的表，並讀回判定。

表內不放任何會影響判斷的線索：沒有相似度、沒有模型的判斷、沒有做法的名稱。
每份表帶一個批次代碼（藏在隱藏工作表），讀回時用來確認它與對照檔是同一次抽樣的結果。
外部來的文字一律當成純文字寫入：以「=」開頭的不會變成公式，Excel 不接受的控制字元先拿掉。
"""

import os
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.worksheet import Worksheet

from shared.audit.metrics import LINK_CHOICES, PAIR_CHOICES
from shared.audit.sampling import LinkItem, PairItem

GUIDE_SHEET, LINK_SHEET, PAIR_SHEET, META_SHEET = "填寫說明", "技能對應", "相近配對", "_meta"
VERDICT, NOTE = "判定", "備註"
FIRST, SECOND = "標註者甲", "標註者乙"
SOURCE_NAMES = {"course": "課程", "advisor": "教師", "competition": "比賽"}
QUESTIONS = {"course": "這門課有教這項技能嗎？", "advisor": "這位教師具備這項專長嗎？", "competition": "這場比賽需要這項技能嗎？"}
LINK_COLUMNS = (("編號", 10), ("來源", 7), ("要判斷的事", 20), ("對象", 26), ("原文證據", 46), ("技能（中文）", 18),
                ("技能（ESCO 名稱）", 26), ("技能說明（ESCO）", 50), ("補充脈絡", 40))
PAIR_COLUMNS = (("編號", 10), ("技能甲（中文）", 18), ("技能甲（ESCO 名稱）", 26), ("技能甲說明", 46),
                ("技能乙（中文）", 18), ("技能乙（ESCO 名稱）", 26), ("技能乙說明", 46))
GUIDE = (
    "技能對應與相近配對的人工複核",
    "",
    "兩位複核者各填一份，填完之前請不要互相討論；有疑慮寫在「備註」。只填「判定」與「備註」兩欄，其他欄位不要改。",
    "拿不定主意時照自己的判斷選一個，並在「備註」寫下猶豫的原因；兩人判定不同的項目之後會一起討論。",
    "",
    "一、「技能對應」工作表：這段原文能不能支持「要判斷的事」？",
    "　正確　　：原文講的能力，與技能的名稱、說明是同一件事（用詞不同沒關係）。",
    "　粒度不符：領域相同，但技能比原文講的明顯更寬或更窄。例如原文只說「程式設計」，技能卻是某一種程式語言。",
    "　錯誤　　：只是字面相近、領域不同；或原文不是在講能力（獎項、報名方式、機關名稱）；或要靠很多推測才扯得上。",
    "　只根據「原文證據」與「補充脈絡」判斷，不要因為「這門課應該會教」「這位老師應該會」而補上原文沒寫的事。",
    "　「補充脈絡」是課程簡介、教師的專長條列或比賽摘要，只用來理解原文在講什麼。「（本人）」「（教師）」是被遮蔽的教師姓名。",
    "",
    "二、「相近配對」工作表：兩項技能是什麼關係？（用來決定具備其中一項，能不能當作部分具備另一項）",
    "　相同　　　：同一種能力的不同說法，可以互相替代。「某知識」與「運用該知識」也算相同。",
    "　上下位　　：其中一項是另一項的「一種」，「甲是一種乙」說得通；學科的分支也算。",
    "　相關但不同：同一個領域的不同能力。其中一項只是另一項的步驟、組成、工具或基礎知識，也屬於這一類。",
    "　無關　　　：只有字面相近，領域或意思不同。",
    "",
    "技能名稱與說明取自歐盟 ESCO 技能目錄（英文）；中文名稱是機器翻譯，只供參考，以英文名稱與說明為準。",
)
HEADER_FILL = PatternFill("solid", fgColor="DDEBF7")
VERDICT_FILL = PatternFill("solid", fgColor="FFF2CC")
WRAP = Alignment(wrap_text=True, vertical="top")
TEXT_TYPE = "s"
MAX_ROWS = 200_000   # 防止整欄被套了格式的表讓讀取跑不完；實際的表只有幾百列


def _clean(value: object) -> object:
    return ILLEGAL_CHARACTERS_RE.sub("", value) if isinstance(value, str) else value


def _link_row(item: LinkItem) -> list[str]:
    return [item.sample_id, SOURCE_NAMES[item.source], QUESTIONS[item.source], item.subject, item.evidence,
            item.skill_zh, item.skill_en, item.skill_description, item.context]


def _pair_row(item: PairItem) -> list[str]:
    return [item.sample_id, item.a["zh"], item.a["en"], item.a["description"],
            item.b["zh"], item.b["en"], item.b["description"]]


def _append(worksheet: Worksheet, values: list) -> None:
    """加一列；字串一律存成文字（以「=」開頭的也不當成公式），並套用自動換行。"""
    worksheet.append([_clean(value) for value in values])
    for cell in worksheet[worksheet.max_row]:
        if isinstance(cell.value, str):
            cell.data_type = TEXT_TYPE
        cell.alignment = WRAP


def _write_sheet(worksheet: Worksheet, columns: tuple, rows: list[list[str]], choices: tuple[str, ...],
                 previous: dict[str, tuple] | None, decided: dict[str, str], notes: dict[str, str]) -> None:
    """previous 有值時（裁決表）多兩欄顯示兩位標註者各自的判定；decided、notes 是先前填過的內容。"""
    extra = ((FIRST, 12), (SECOND, 12)) if previous is not None else ()
    headers = (*columns, *extra, (VERDICT, 14), (NOTE, 30))
    worksheet.append([name for name, _ in headers])
    for row in rows:
        sample_id = row[0]
        _append(worksheet, [*row, *(previous[sample_id] if previous is not None else ()),
                            decided.get(sample_id), notes.get(sample_id)])
    verdict_column = len(columns) + len(extra) + 1
    for index, (_, width) in enumerate(headers, 1):
        cell = worksheet.cell(row=1, column=index)
        worksheet.column_dimensions[cell.column_letter].width = width
        cell.font = Font(bold=True)
        cell.fill = VERDICT_FILL if index == verdict_column else HEADER_FILL
    letter = worksheet.cell(row=1, column=verdict_column).column_letter
    validation = DataValidation(type="list", formula1='"' + ",".join(choices) + '"', allow_blank=True)
    validation.add(f"{letter}2:{letter}{max(2, len(rows) + 1)}")
    worksheet.add_data_validation(validation)
    worksheet.freeze_panes = "B2"


def write_workbook(path: Path, links: list[LinkItem], pairs: list[PairItem], *, batch: str,
                   previous: dict[str, tuple] | None = None, decided: dict[str, str] | None = None,
                   notes: dict[str, str] | None = None) -> None:
    """寫出複核表；previous 有值時寫成裁決表（只含傳入的項目，並列出兩位標註者的判定）。

    先寫到暫存檔再換過去：寫到一半失敗時，原本的檔案（可能是唯一一份裁決結果）不會壞掉。
    """
    workbook = Workbook()
    guide = workbook.active
    guide.title = GUIDE_SHEET
    for line in GUIDE:
        guide.append([line])
    guide.column_dimensions["A"].width = 120
    guide["A1"].font = Font(bold=True, size=14)
    decided, notes = decided or {}, notes or {}
    _write_sheet(workbook.create_sheet(LINK_SHEET), LINK_COLUMNS, [_link_row(item) for item in links],
                 LINK_CHOICES, previous, decided, notes)
    _write_sheet(workbook.create_sheet(PAIR_SHEET), PAIR_COLUMNS, [_pair_row(item) for item in pairs],
                 PAIR_CHOICES, previous, decided, notes)
    meta = workbook.create_sheet(META_SHEET)
    meta.append(["batch", batch])
    meta.sheet_state = "hidden"
    path = Path(path)
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        workbook.save(temporary)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_sheet(worksheet: Worksheet, choices: tuple[str, ...]) -> dict:
    header = [cell.value for cell in next(worksheet.iter_rows(min_row=1, max_row=1))]
    if VERDICT not in header:
        raise ValueError(f"工作表「{worksheet.title}」缺少「{VERDICT}」欄")
    verdict, note = header.index(VERDICT), (header.index(NOTE) if NOTE in header else None)
    labels: dict[str, str | None] = {}
    raw: dict[str, str] = {}
    notes: dict[str, str] = {}
    for row in worksheet.iter_rows(min_row=2, max_row=MAX_ROWS, values_only=True):
        if not row or not row[0]:
            continue
        sample_id = str(row[0])
        value = str(row[verdict]).strip() if row[verdict] is not None else ""
        labels[sample_id] = value if value in choices else None
        if value:
            raw[sample_id] = value
        if note is not None and row[note] is not None and str(row[note]).strip():
            notes[sample_id] = str(row[note])
    return {"labels": labels, "raw": raw, "notes": notes}


def read_labels(path: Path) -> dict:
    """讀回一份表：

    links、pairs：{編號: 判定或 None}，選項以外的值視為未填；invalid：[(編號, 填入的值)]；
    raw：{編號: 判定欄原本的文字}；notes：{編號: 備註}；batch：批次代碼（舊表沒有時為 None）。
    """
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        links = _read_sheet(workbook[LINK_SHEET], LINK_CHOICES)
        pairs = _read_sheet(workbook[PAIR_SHEET], PAIR_CHOICES)
        batch = workbook[META_SHEET]["B1"].value if META_SHEET in workbook.sheetnames else None
    finally:
        workbook.close()
    raw = {**links["raw"], **pairs["raw"]}
    labels = {**links["labels"], **pairs["labels"]}
    return {"links": links["labels"], "pairs": pairs["labels"], "raw": raw,
            "notes": {**links["notes"], **pairs["notes"]}, "batch": batch,
            "invalid": [(sample_id, value) for sample_id, value in raw.items() if labels.get(sample_id) is None]}
