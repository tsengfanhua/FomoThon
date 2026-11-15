"""以正式 MCP stdio 與真實資料庫進行有上限的驗收。"""
import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from shared.esco.repository import EscoRepository
from app.database import get_indexed_course
from app.services.course_resolver import resolve_local_course
from app.services.skill_extraction import _syllabus_sections
from app.services.llm_client import load_settings

COURSES = [
    {'academic_year': 114, 'semester': 2, 'course_code': '0772', 'course_name': 'Python程式設計與應用', 'credits': None, 'grade': None},
    {'academic_year': 114, 'semester': 2, 'course_code': '1193', 'course_name': '資料庫設計', 'credits': None, 'grade': None},
]
PARTIAL_PROBE = {'academic_year': 114, 'semester': 2, 'course_code': None, 'course_name': '__acceptance_missing_course__', 'credits': None, 'grade': None}
STEPS = {'transcript_parsing', 'course_resolution', 'website_fallback', 'esco_candidate_search', 'llm_skill_selection', 'skill_validation', 'profile_aggregation'}
SOURCES = {'confirmed_json', 'local_index', 'website', 'website_cache', 'public_website', 'shared_esco', 'llm', 'course_agent'}


def preflight(course_db, esco_db, records):
    for path, table, expected in ((course_db, 'courses', 16490), (esco_db, 'esco_skills', 13939)):
        with closing(sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True)) as conn:
            count = conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
            if count != expected:
                raise ValueError(f'{table} 筆數為 {count}，預期 {expected}；請檢查正式資料庫')
    ids = []
    for record in records:
        result = resolve_local_course(course_db, record)
        if result['status'] != 'matched':
            raise ValueError('正式課程無法唯一匹配或課綱不完整')
        course = result['course']
        if (course['year'], course['semester'], course['course_code'], course['course_name'].strip()) != (record['academic_year'], record['semester'], record['course_code'], record['course_name']):
            raise ValueError('正式課程識別資訊不一致')
        ids.append(course['course_id'])
    return ids


def verify_result(result, course_db, esco_db, expected_ids, partial):
    """僅輸出可核對的欄位；不持久化輸入、原文或任意錯誤字串。"""
    run_id = str(uuid.UUID(result['run_id']))
    expected_status = 'partial' if partial else 'complete'
    if result.get('status') != expected_status:
        raise ValueError('MCP 執行狀態與預期不同，未通過驗收')
    courses = result.get('courses', [])
    if len(courses) != len(expected_ids) + int(partial):
        raise ValueError('課程結果數量不一致')
    for index, expected_id in enumerate(expected_ids):
        course = courses[index]
        if course.get('status') != 'matched' or course.get('course_id') != expected_id or course.get('skills_status') not in ('mapped', 'unmapped'):
            raise ValueError('課程匹配或技能萃取失敗')
    if partial and (courses[-1].get('status') != 'needs_confirmation' or courses[-1].get('reason') != 'course_code_required'):
        raise ValueError('部分失敗情境未如預期回報')
    if partial and not any(item.get('index') == len(expected_ids) and item.get('error_code') == 'course_code_required' for item in result.get('issues', [])):
        raise ValueError('部分失敗項目未列於 issues')
    if not partial and result.get('issues'):
        raise ValueError('執行結果包含待確認或錯誤項目')
    def no_scores(value):
        if isinstance(value, dict):
            return all(not re.search(r'score|proficiency|dimension', str(k), re.I) and no_scores(v) for k, v in value.items())
        if isinstance(value, list):
            return all(no_scores(v) for v in value)
        return True
    if not no_scores(result):
        raise ValueError('結果包含技能分數或熟練度欄位')
    trace = []
    for event in result.get('trace', []):
        if event.get('run_id') != run_id or event.get('step') not in STEPS or event.get('source') not in SOURCES:
            raise ValueError('Trace 內容無法驗證')
        if not isinstance(event.get('duration_ms'), (int, float)) or not math.isfinite(event['duration_ms']) or event['duration_ms'] < 0:
            raise ValueError('Trace 耗時無效')
        if not re.fullmatch(r'[a-z_]+', event.get('status', '')) or (event.get('error_code') and not re.fullmatch(r'[a-z_]+', event['error_code'])):
            raise ValueError('Trace 狀態或錯誤碼無效')
        trace.append({key: event[key] for key in ('run_id', 'step', 'status', 'duration_ms', 'source', 'error_code') if key in event})
    required = {'transcript_parsing', 'course_resolution', 'esco_candidate_search', 'profile_aggregation'}
    if not required <= {event['step'] for event in trace}:
        raise ValueError('Trace 缺少必要步驟')
    if result.get('skills') and not {'llm_skill_selection', 'skill_validation'} <= {event['step'] for event in trace}:
        raise ValueError('有技能結果但 Trace 缺少模型選擇或證據驗證步驟')
    if partial and not any(e['step'] == 'course_resolution' and e.get('error_code') == 'course_code_required' for e in trace):
        raise ValueError('Trace 未記錄部分失敗')
    repo = EscoRepository(esco_db)
    skills = result.get('skills', [])
    evidence_by_uri = {e['conceptUri']: e['sources'] for e in result.get('skill_evidence', [])}
    if len(evidence_by_uri) != len(result.get('skill_evidence', [])):
        raise ValueError('重複技能證據項目')
    if len({s['conceptUri'] for s in skills}) != len(skills) or set(evidence_by_uri) != {s['conceptUri'] for s in skills}:
        raise ValueError('技能與證據不一致或未去重')
    verified = []
    for skill in skills:
        if set(skill) != {'conceptUri', 'preferredLabel', 'description'}:
            raise ValueError('技能欄位不符合契約')
        uri = skill['conceptUri']
        official = repo.get(uri)
        if not official or (skill['preferredLabel'], skill['description']) != (official['preferred_label'], official['description']):
            raise ValueError('ESCO URI、名稱或描述不一致')
        sources = []
        for source in evidence_by_uri[uri]:
            course_id, section, quote = source['course_id'], source['source_section'], source['evidence']
            if course_id not in expected_ids or not isinstance(quote, str) or not quote:
                raise ValueError('技能證據來源無法確認')
            course = get_indexed_course(course_db, course_id)
            text = _syllabus_sections(course).get(section, '')
            if quote not in text:
                raise ValueError('技能證據並非該課程欄位原文')
            sources.append({'course_index': expected_ids.index(course_id), 'source_section': section,
                            'evidence_sha256': hashlib.sha256(quote.encode('utf-8')).hexdigest(),
                            'evidence_length': len(quote), 'verified': True})
        if not sources:
            raise ValueError('技能缺少來源證據')
        verified.append({'conceptUri': uri, 'preferredLabel': official['preferred_label'],
                         'description': official['description'], 'sources': sources})
    return {'run_id': run_id, 'status': result['status'], 'course_count': len(expected_ids),
            'partial_probe': partial, 'courses': [{'index': i, 'status': c['status'], 'skills_status': c['skills_status']} for i,c in enumerate(courses)],
            'skills': verified, 'trace': trace, 'checks': {'esco_verified_count': len(verified),
            'evidence_verified_count': sum(len(s['sources']) for s in verified), 'no_scores': True},
            'outcome': 'verified' if verified else 'inconclusive_no_skills',
            'note': '原文逐字及 ESCO 主資料檢查不等同於語意正確性或學生能力。'}


async def run(args):
    load_settings()
    if not os.environ.get('OPENAI_API_KEY') or not os.environ.get('SKILL_LLM_MODEL'):
        raise ValueError('缺少環境變數 OPENAI_API_KEY 或 SKILL_LLM_MODEL；未呼叫模型')
    course_db, esco_db = args.course_db.resolve(), args.esco_db.resolve()
    records = COURSES[:args.courses]
    expected_ids = preflight(course_db, esco_db, records)
    params = StdioServerParameters(command=sys.executable, args=['-m', 'app.mcp_server', '--course-db', str(course_db), '--esco-db', str(esco_db), '--model', os.environ['SKILL_LLM_MODEL']], env={'OPENAI_API_KEY': os.environ['OPENAI_API_KEY'], 'SKILL_LLM_MODEL': os.environ['SKILL_LLM_MODEL']})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            if 'analyze_student_courses' not in [tool.name for tool in (await session.list_tools()).tools]:
                raise ValueError('MCP Server 未提供預期工具')
            response = await session.call_tool('analyze_student_courses', {'enrollments': records + ([PARTIAL_PROBE] if args.partial else [])})
            if response.isError:
                raise ValueError('MCP 工具回報錯誤；未保存驗收結果')
            result = response.structuredContent or json.loads(response.content[0].text)
    report = verify_result(result, course_db, esco_db, expected_ids, args.partial)
    report['validated_at'] = datetime.now(timezone.utc).isoformat()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    target = args.output_dir / f"mcp-acceptance-{report['run_id']}.json"
    with target.open('x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
    print(f"驗收狀態：{report['status']}；結果：{report['outcome']}；課程：{len(expected_ids)}；驗證技能：{len(report['skills'])}")
    print(f'已保存去識別化結果：{target.resolve()}')
    return report


def main():
    parser = argparse.ArgumentParser(description='正式 MCP 驗收：每次最多分析兩門課。')
    parser.add_argument('--courses', type=int, choices=(1, 2), required=True)
    parser.add_argument('--partial', action='store_true', help='加入無代碼的合成失敗案例，不增加模型呼叫')
    parser.add_argument('--course-db', type=Path, default=Path('data/processed/course_index.sqlite'))
    parser.add_argument('--esco-db', type=Path, default=Path('../data/shared/esco_skills.sqlite'))
    parser.add_argument('--output-dir', type=Path, default=Path('data/processed/mcp-acceptance'))
    args = parser.parse_args()
    try:
        report = asyncio.run(run(args))
        if report['outcome'] != 'verified':
            raise SystemExit(2)
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(f'驗收未完成：{exc}', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
