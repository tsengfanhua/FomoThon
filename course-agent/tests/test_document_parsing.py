import json

import pytest

from app.services.document_parser import DocumentParseError, parse_document
from app.services.enrollment_extractor import extract_enrollments
from app.services.course_resolver import resolve_course
from scripts.generate_synthetic_transcripts import DEMO_KEYS, STUDENT_COURSE_INDEXES, generate


def test_transcript_formats_and_matches(tmp_path, demo_course_db):
    generate(tmp_path, demo_course_db)
    cases = json.loads((tmp_path / 'expected_enrollments.json').read_text(encoding='utf-8'))
    assert sum(len(cases[name]) for name in STUDENT_COURSE_INDEXES) == 31
    for student, indexes in STUDENT_COURSE_INDEXES.items():
        for ext in ('json', 'pdf', 'xlsx'):
            path = tmp_path / f'{student}.{ext}'
            records, warnings, missing = extract_enrollments(parse_document(path.name, path.read_bytes()))
            assert records == cases[student] and not warnings and not missing
            for index, record in zip(indexes, records):
                assert set(record) == {'academic_year', 'semester', 'course_code', 'course_name', 'credits', 'grade'}
                assert record['course_code'] == DEMO_KEYS[index][2]
                result = resolve_course(demo_course_db, record, fetcher=lambda *args: pytest.fail('不應呼叫網站'))
                assert result['status'] == 'matched' and result['course']['course_id'] == f'c{index}'
                assert result['course']['course_code'] == record['course_code']
    assert len({tuple(cases[name][i]['course_code'] for i in range(len(cases[name]))) for name in STUDENT_COURSE_INDEXES}) == 5
    groups = [{r['course_code'] for r in cases[name]} for name in STUDENT_COURSE_INDEXES]
    assert set.intersection(*groups)
    assert all(group - set.union(*(other for j, other in enumerate(groups) if j != i)) for i, group in enumerate(groups))
    for name in ('case_missing_grade', 'case_unmatched_course', 'case_duplicate_enrollment'):
        for ext in ('json', 'pdf', 'xlsx'):
            path = tmp_path / f'{name}.{ext}'
            records, warnings, missing = extract_enrollments(parse_document(path.name, path.read_bytes()))
            assert records == cases[name] and not warnings and not missing
    assert cases['case_missing_grade'][0]['grade'] is None
    assert cases['case_duplicate_enrollment'][0] == cases['case_duplicate_enrollment'][1]
    assert resolve_course(demo_course_db, cases['case_unmatched_course'][0])['status'] != 'matched'
    assert '合成資料' in (tmp_path / 'README.txt').read_text(encoding='utf-8')
    with pytest.raises(FileExistsError):
        generate(tmp_path, demo_course_db)


def test_generator_rejects_ambiguous_or_incomplete(tmp_path, demo_course_db):
    import sqlite3
    with sqlite3.connect(demo_course_db) as conn:
        conn.execute("UPDATE courses SET description=NULL WHERE selection_code=?", (DEMO_KEYS[0][2],))
    with pytest.raises(ValueError, match='課綱不足'):
        generate(tmp_path, demo_course_db)
    with sqlite3.connect(demo_course_db) as conn:
        conn.execute("UPDATE courses SET description='介紹' WHERE selection_code=?", (DEMO_KEYS[0][2],))
        conn.execute("INSERT INTO courses SELECT 'conflict', year, semester, selection_code, course_name, description, targets, weekly_schedule FROM courses WHERE selection_code=?", (DEMO_KEYS[0][2],))
    with pytest.raises(ValueError, match='無法唯一辨識'):
        generate(tmp_path, demo_course_db)


def test_current_transcript_rejects_internal_id_column():
    records, warnings, _ = extract_enrollments([
        ['academic_year', 'semester', 'course_name', 'course_id'], [114, 2, '範例', 'internal']])
    assert warnings and 'course_id' not in records[0]


def test_missing_fields_and_invalid_grade():
    records, warnings, missing = extract_enrollments([['course_name', 'grade'], ['Example', 'pass']])
    assert records[0]['grade'] is None
    assert set(missing) == {'course_id', 'semester'}
    assert warnings


def test_invalid_pdf_and_unsupported_extension():
    for filename in ('bad.pdf', 'bad.doc'):
        with pytest.raises(DocumentParseError):
            parse_document(filename, b'not a document')
