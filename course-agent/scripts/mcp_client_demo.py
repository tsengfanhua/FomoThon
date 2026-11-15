"""啟動隔離的 Mock MCP Server，列出工具並呼叫一次。"""
import asyncio
import json
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from app.database import INDEX_SCHEMA


def fixtures(root):
    course_db, esco_db = root / 'courses.sqlite', root / 'esco.sqlite'
    with closing(sqlite3.connect(course_db)) as conn:
        with conn:
            for statement in INDEX_SCHEMA:
                conn.execute(statement)
            conn.execute('CREATE TABLE mcp_mock_fixture (id INTEGER)')
            for i in (1, 2):
                conn.execute('INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                             (f'course-{i}', 113, 2, f'{i:04}', f'合成課程{i}', '介紹', '["目標"]',
                              '[{"tpd_reading":"", "tpd_learn":"練習 Swift 程式設計"}]'))
    with closing(sqlite3.connect(esco_db)) as conn:
        with conn:
            conn.execute('CREATE TABLE mcp_mock_fixture (id INTEGER)')
            conn.execute('CREATE TABLE esco_skills (concept_uri TEXT PRIMARY KEY, preferred_label TEXT, description TEXT)')
            conn.execute("INSERT INTO esco_skills VALUES ('uri:swift','Swift programming','mock skill')")
    return course_db, esco_db


async def run_demo():
    with tempfile.TemporaryDirectory() as tmp:
        course_db, esco_db = fixtures(Path(tmp))
        params = StdioServerParameters(command=sys.executable, args=['-m', 'app.mcp_server', '--mock',
                                      '--course-db', str(course_db), '--esco-db', str(esco_db)])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                print('tools:', ', '.join(tool.name for tool in tools.tools))
                records = [{'academic_year': 113, 'semester': 2, 'course_code': f'{i:04}',
                            'course_name': f'合成課程{i}', 'credits': 3, 'grade': 80} for i in (1, 2)]
                result = await session.call_tool('analyze_student_courses', {'enrollments': records})
                output = result.structuredContent
                if output is None and result.content and result.content[0].type == 'text':
                    output = json.loads(result.content[0].text)
                print(json.dumps(output, ensure_ascii=False, indent=2))
                if result.isError:
                    raise RuntimeError('MCP Tool 呼叫失敗')


if __name__ == '__main__':
    asyncio.run(run_demo())
