"""設定載入與 MCP 子程序設定傳遞的離線測試。"""
import asyncio
import os
from argparse import Namespace
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.services import llm_client
from scripts import mcp_acceptance


def test_dotenv_path_is_absolute_and_settings_ignore_cwd(tmp_path, monkeypatch):
    assert llm_client.ENV_PATH.is_absolute()
    assert llm_client.ENV_PATH == Path(llm_client.__file__).resolve().parents[2] / '.env'
    settings = tmp_path / 'course.env'
    settings.write_text('OPENAI_API_KEY=synthetic-key\nSKILL_LLM_MODEL=synthetic-model\n', encoding='utf-8')
    monkeypatch.setattr(llm_client, 'ENV_PATH', settings)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv('SKILL_LLM_MODEL', raising=False)
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    status = llm_client.load_settings()
    assert status == {'OPENAI_API_KEY': {'present': True, 'source': 'dotenv'},
                      'SKILL_LLM_MODEL': {'present': True, 'source': 'dotenv'}}
    assert os.environ['SKILL_LLM_MODEL'] == 'synthetic-model'
    assert 'synthetic-key' not in repr(status)


def test_system_environment_has_priority(tmp_path, monkeypatch):
    settings = tmp_path / 'course.env'
    settings.write_text('OPENAI_API_KEY=synthetic-file\nSKILL_LLM_MODEL=file-model\n', encoding='utf-8')
    monkeypatch.setattr(llm_client, 'ENV_PATH', settings)
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-env')
    monkeypatch.setenv('SKILL_LLM_MODEL', 'env-model')
    status = llm_client.load_settings()
    assert all(item['source'] == 'environment' for item in status.values())
    assert os.environ['OPENAI_API_KEY'] == 'synthetic-env'
    assert os.environ['SKILL_LLM_MODEL'] == 'env-model'


def test_acceptance_passes_settings_to_stdio_server(tmp_path, monkeypatch):
    settings = tmp_path / 'course.env'
    settings.write_text('OPENAI_API_KEY=synthetic-key\nSKILL_LLM_MODEL=synthetic-model\n', encoding='utf-8')
    monkeypatch.setattr(llm_client, 'ENV_PATH', settings)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv('SKILL_LLM_MODEL', raising=False)
    monkeypatch.setattr(mcp_acceptance, 'preflight', lambda *args: ['id'])
    received = {}
    @asynccontextmanager
    async def fake_stdio(params):
        received['env'] = params.env
        received['args'] = params.args
        yield None, None
    class FakeSession:
        def __init__(self, *args): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def initialize(self): pass
        async def list_tools(self): return SimpleNamespace(tools=[])
    monkeypatch.setattr(mcp_acceptance, 'stdio_client', fake_stdio)
    monkeypatch.setattr(mcp_acceptance, 'ClientSession', FakeSession)
    args = Namespace(course_db=tmp_path / 'course', esco_db=tmp_path / 'esco', courses=1, partial=False, output_dir=tmp_path)
    with pytest.raises(ValueError, match='未提供預期工具'):
        asyncio.run(mcp_acceptance.run(args))
    assert received['env']['OPENAI_API_KEY'] == 'synthetic-key'
    assert received['env']['SKILL_LLM_MODEL'] == 'synthetic-model'
    assert received['args'][-2:] == ['--model', 'synthetic-model']
    assert 'synthetic-key' not in repr(received['args'])


def test_real_server_starts_with_synthetic_environment_without_api_calls(tmp_path):
    import sys
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from scripts.mcp_client_demo import fixtures

    course_db, esco_db = fixtures(tmp_path)
    async def check():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'app.mcp_server',
            '--course-db', str(course_db), '--esco-db', str(esco_db)],
            env={'OPENAI_API_KEY': 'synthetic-key', 'SKILL_LLM_MODEL': 'synthetic-model'})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                assert 'analyze_student_courses' in [tool.name for tool in (await session.list_tools()).tools]
    asyncio.run(check())
