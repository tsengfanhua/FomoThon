"""從支援的成績單格式擷取表格，不將內容傳送至外部服務。"""

from io import BytesIO
from pathlib import Path

from openpyxl import load_workbook
from pypdf import PdfReader


class DocumentParseError(ValueError):
    """文件無法解析或不屬於支援格式。"""


def parse_document(filename: str, content: bytes) -> list[list[str]]:
    """回傳文字表格；PDF MVP 僅支援以直線符號分欄的文字型文件。"""
    extension = Path(filename).suffix.lower()
    try:
        if extension == ".xlsx":
            workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
            try:
                return [[str(cell).strip() if cell is not None else "" for cell in row]
                        for row in workbook.active.iter_rows(values_only=True)]
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
    raise DocumentParseError("僅支援 PDF 與 XLSX")
