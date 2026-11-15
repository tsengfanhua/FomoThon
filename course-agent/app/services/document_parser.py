"""從支援的成績單格式擷取表格，不將內容傳送至外部服務。"""

from io import BytesIO
import json
import re
from pathlib import Path

from openpyxl import load_workbook
from pypdf import PdfReader


class DocumentParseError(ValueError):
    """文件無法解析或不屬於支援格式。"""


def parse_document(filename: str, content: bytes) -> list[list[str]]:
    """回傳文字表格；PDF MVP 僅支援以直線符號分欄的文字型文件。"""
    extension = Path(filename).suffix.lower()
    try:
        if extension == ".json":
            data = json.loads(content.decode("utf-8-sig"))
            if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
                raise DocumentParseError("JSON 必須是修課紀錄陣列")
            headers = list(dict.fromkeys(key for item in data for key in item))
            return [headers] + [[item.get(key) for key in headers] for item in data]
        if extension == ".xlsx":
            workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
            try:
                def value(cell):
                    v = cell.value
                    if isinstance(v, int) and not isinstance(v, bool) and re.fullmatch(r"0+", cell.number_format or ""):
                        return str(v).zfill(len(cell.number_format))
                    return str(v).strip() if v is not None else ""
                return [[value(cell) for cell in row] for row in workbook.active.iter_rows()]
            finally:
                workbook.close()
        if extension == ".pdf":
            reader = PdfReader(BytesIO(content))
            if reader.is_encrypted:
                raise DocumentParseError("不支援加密 PDF")
            lines = []
            for page in reader.pages:
                lines.extend((page.extract_text() or "").splitlines())
            rows = [[cell.strip() for cell in line.split("|")] for line in lines if "|" in line]
            if not rows:
                raise DocumentParseError("無法辨識文字表格；掃描影像及非直線符號分欄的 PDF 不受支援")
            return rows
    except DocumentParseError:
        raise
    except Exception as exc:
        raise DocumentParseError("文件損壞或格式不受支援") from exc
    raise DocumentParseError("僅支援 JSON、PDF 與 XLSX")
