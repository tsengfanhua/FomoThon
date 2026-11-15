"""驗收客戶端只在隔離的 Mock 資料上執行離線測試。"""
import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from scripts.mcp_acceptance import verify_result, run
from scripts.mcp_client_demo import fixtures


def test_missing_settings_stops_without_model(monkeypatch, tmp_path):
    from argparse import Namespace
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv('SKILL_LLM_MODEL', raising=False)
    monkeypatch.setattr('app.services.llm_client.ENV_PATH', tmp_path / 'missing.env')
    with pytest.raises(ValueError, match='缺少環境變數'):
        asyncio.run(run(Namespace(course_db=tmp_path, esco_db=tmp_path, courses=1, partial=False, output_dir=tmp_path)))
    assert list(tmp_path.iterdir()) == []


def test_acceptance_validates_mcp_response_and_evidence(tmp_path):
    course_db, esco_db = fixtures(tmp_path)
    async def exercise():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'app.mcp_server', '--mock', '--course-db', str(course_db), '--esco-db', str(esco_db)])
        records = [{'academic_year':113, 'semester':2, 'course_code':f'{i:04}', 'course_name':f'合成課程{i}', 'credits':None, 'grade':None} for i in (1,2)]
        records.append({'academic_year':113, 'semester':2, 'course_code':None, 'course_name':'未知', 'credits':None, 'grade':None})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                response = await session.call_tool('analyze_student_courses', {'enrollments':records})
                assert not response.isError
                return response.structuredContent or json.loads(response.content[0].text)
    raw = asyncio.run(exercise())
    report = verify_result(raw, course_db, esco_db, ['course-1', 'course-2'], True)
    assert report['outcome'] == 'verified' and report['checks']['evidence_verified_count'] == 2
    serialized = json.dumps(report, ensure_ascii=False)
    assert '練習 Swift 程式設計' not in serialized and '合成課程' not in serialized
    altered = copy.deepcopy(raw)
    altered['skills'][0]['preferredLabel'] = '錯誤'
    with pytest.raises(ValueError, match='ESCO'):
        verify_result(altered, course_db, esco_db, ['course-1', 'course-2'], True)
    altered = copy.deepcopy(raw)
    altered['skill_evidence'][0]['sources'][0]['evidence'] = '不在課綱中的文字'
    with pytest.raises(ValueError, match='證據'):
        verify_result(altered, course_db, esco_db, ['course-1', 'course-2'], True)
    altered = copy.deepcopy(raw)
    altered['skills'][0]['score'] = 99
    with pytest.raises(ValueError, match='分數'):
        verify_result(altered, course_db, esco_db, ['course-1', 'course-2'], True)
    altered = copy.deepcopy(raw)
    altered['skills'] = []
    altered['skill_evidence'] = []
    assert verify_result(altered, course_db, esco_db, ['course-1', 'course-2'], True)['outcome'] == 'inconclusive_no_skills'
