"""MCP stdio client/server 的離線整合驗證。"""
import asyncio
import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from scripts.mcp_client_demo import fixtures


def content(result):
    return result.structuredContent or json.loads(result.content[0].text)


def test_stdio_mcp_end_to_end(tmp_path):
    course_db, esco_db = fixtures(tmp_path)
    async def exercise():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'app.mcp_server', '--mock', '--course-db', str(course_db), '--esco-db', str(esco_db)])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                assert 'analyze_student_courses' in [t.name for t in (await session.list_tools()).tools]
                records = [{'academic_year': 113, 'semester': 2, 'course_code': f'{i:04}', 'course_name': f'合成課程{i}', 'credits': 3, 'grade': 80} for i in (1, 2)]
                records.append({'academic_year': 113, 'semester': 2, 'course_code': None, 'course_name': '不存在', 'credits': None, 'grade': None})
                response = await session.call_tool('analyze_student_courses', {'enrollments': records})
                assert not response.isError
                result = content(response)
                assert result['status'] == 'partial' and len(result['skills']) == 1
                assert set(result['skills'][0]) == {'conceptUri', 'preferredLabel', 'description'}
                assert len(result['skill_evidence'][0]['sources']) == 2
                assert result['issues'][0]['error_code'] == 'course_code_required'
                assert len(result['trace']) > 0 and all(e['run_id'] == result['run_id'] and e['duration_ms'] >= 0 for e in result['trace'])
                assert {'transcript_parsing', 'course_resolution', 'esco_candidate_search', 'llm_skill_selection', 'skill_validation', 'profile_aggregation'} <= {e['step'] for e in result['trace']}
                assert any(e.get('error_code') == 'course_code_required' for e in result['trace'])
                assert 'website_fallback' not in {e['step'] for e in result['trace']}
                assert all('合成課程' not in json.dumps(e, ensure_ascii=False) and 'grade' not in json.dumps(e) for e in result['trace'])
                assert 'score' not in json.dumps(result)
                second = content(await session.call_tool('analyze_student_courses', {'enrollments': []}))
                assert second['status'] == 'invalid_input' and second['run_id'] != result['run_id']
                bad = await session.call_tool('analyze_student_courses', {'enrollments': [{**records[0], 'grade': 101}]})
                assert bad.isError
    asyncio.run(exercise())
