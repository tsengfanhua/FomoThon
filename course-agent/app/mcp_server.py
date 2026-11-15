"""Course Agent MCP stdio server。"""
import argparse
import json
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mcp.server.fastmcp import FastMCP
from shared.esco.repository import EscoRepository
from app.schemas.skills import Enrollment
from app.services.esco_profile import analyze_esco_enrollments
from app.services.llm_client import OpenAIClient, load_settings
from app.services.trace import Trace


class MockClient:
    """僅供隔離測試資料庫使用的固定模型回應。"""
    def generate(self, system_prompt, user_prompt):
        if '搜尋詞' in system_prompt:
            return json.dumps({'terms': ['swift']})
        return json.dumps({'matches': [{'conceptUri': 'uri:swift', 'source_section': 'weeklyScds[0].tpd_learn',
                                        'evidence': '練習 Swift 程式設計'}], 'unmapped': []}, ensure_ascii=False)


def validate_database(path, required, mock=False):
    with closing(sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True)) as conn:
        for table, columns in required.items():
            present = {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}
            if not set(columns) <= present:
                raise ValueError(f'資料庫缺少必要欄位：{table}')
        if mock and not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_mock_fixture'").fetchone():
            raise ValueError('Mock 模式僅允許使用隔離的測試資料庫')


def create_server(course_db: Path, esco_db: Path, client):
    validate_database(course_db, {'courses': ['course_id', 'year', 'semester', 'selection_code', 'course_name', 'description', 'targets', 'weekly_schedule'],
                                  'course_skills': ['course_id', 'concept_uri', 'source_section', 'evidence']})
    validate_database(esco_db, {'esco_skills': ['concept_uri', 'preferred_label', 'description']})
    repository = EscoRepository(esco_db)
    server = FastMCP('Course Agent', instructions='修課資料須先經人工確認；技能結果不是熟練度。')

    @server.tool()
    def analyze_student_courses(enrollments: list[Enrollment]) -> dict:
        """分析已確認修課紀錄：academic_year、semester、course_code、course_name、credits、grade。"""
        trace = Trace()
        started = perf_counter()
        if not enrollments:
            trace.record('transcript_parsing', 'failed', started, 'confirmed_json', 'empty_enrollments')
            return {'run_id': trace.run_id, 'status': 'invalid_input', 'courses': [], 'skills': [],
                    'skill_evidence': [], 'issues': [{'error_code': 'empty_enrollments'}], 'trace': trace.events}
        trace.record('transcript_parsing', 'success', started, 'confirmed_json')
        result = analyze_esco_enrollments([item.model_dump() for item in enrollments], course_db, repository, client, trace=trace)
        started = perf_counter()
        skills, evidence = [], []
        for skill in result['skills']:
            skills.append({k: skill[k] for k in ('conceptUri', 'preferredLabel', 'description')})
            evidence.append({'conceptUri': skill['conceptUri'], 'sources': skill['evidence']})
        issues = [{'index': i, 'status': item['status'], 'error_code': item.get('reason') or item.get('skills_status')}
                  for i, item in enumerate(result['courses'])
                  if item['status'] != 'matched' or item['skills_status'] not in ('mapped', 'unmapped')]
        courses = [{k: v for k, v in item.items() if k != 'enrollment'} for item in result['courses']]
        successful = any(item['status'] == 'matched' and item['skills_status'] in ('mapped', 'unmapped') for item in result['courses'])
        status = ('partial' if successful else 'failed') if issues else 'complete'
        trace.record('profile_aggregation', status, started, 'course_agent', 'all_courses_failed' if status == 'failed' else None)
        return {'run_id': trace.run_id, 'status': status, 'courses': courses, 'skills': skills,
                'skill_evidence': evidence, 'issues': issues, 'trace': trace.events}
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--course-db', type=Path, default=Path('data/processed/course_index.sqlite'))
    parser.add_argument('--esco-db', type=Path, default=Path('../data/shared/esco_skills.sqlite'))
    parser.add_argument('--model', help='OpenAI 模型名稱；使用外部模型前須確認課綱分享權限')
    parser.add_argument('--mock', action='store_true', help='僅限隔離的合成測試資料庫')
    args = parser.parse_args()
    if args.mock:
        validate_database(args.course_db, {}, mock=True)
        validate_database(args.esco_db, {}, mock=True)
        client = MockClient()
    else:
        load_settings()
        model = args.model or os.environ.get('SKILL_LLM_MODEL')
        if not model:
            parser.error('正式模式需要 --model 或 SKILL_LLM_MODEL')
        client = OpenAIClient(model)
    create_server(args.course_db, args.esco_db, client).run(transport='stdio')


if __name__ == '__main__':
    main()
