import json

import pytest

from app.services.document_parser import DocumentParseError, parse_document
from app.services.enrollment_extractor import extract_enrollments
from scripts.generate_synthetic_transcripts import ANOMALIES, STUDENTS, generate


def test_synthetic_pdf_and_excel_match_json(tmp_path):
    generate(tmp_path)
    expected_cases = json.loads((tmp_path / "expected_enrollments.json").read_text(encoding="utf-8"))
    for student_id in {**STUDENTS, **ANOMALIES}:
        expected = expected_cases[student_id]
        assert json.loads((tmp_path / f"{student_id}.json").read_text(encoding="utf-8")) == expected
        for extension in ("pdf", "xlsx"):
            path = tmp_path / f"{student_id}.{extension}"
            records, warnings, missing = extract_enrollments(parse_document(path.name, path.read_bytes()))
            assert records == expected
            assert warnings == []
            assert missing == []


def test_exception_cases_are_preserved_for_confirmation(tmp_path):
    generate(tmp_path)
    cases = json.loads((tmp_path / "expected_enrollments.json").read_text(encoding="utf-8"))
    assert cases["case_missing_grade"][0]["grade"] is None
    assert cases["case_unmatched_course"][0]["course_id"] == "course_unknown"
    assert len(cases["case_duplicate_enrollment"]) == 2
    assert cases["case_duplicate_enrollment"][0] == cases["case_duplicate_enrollment"][1]


def test_missing_fields_and_invalid_grade():
    records, warnings, missing = extract_enrollments([
        ["course_name", "grade"], ["Example", "pass"]
    ])
    assert records[0]["grade"] is None
    assert set(missing) == {"course_id", "semester"}
    assert warnings


def test_invalid_pdf_and_unsupported_extension():
    for filename in ("bad.pdf", "bad.doc"):
        with pytest.raises(DocumentParseError):
            parse_document(filename, b"not a document")
