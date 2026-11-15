"""Real SDK stdio ClientSession against a guarded subprocess; temporary DBs only."""
import asyncio
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import unittest

import test_skill_proposals as fixtures
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from competition_agent.mcp_server import readers, create_server


class MCPTests(unittest.TestCase):
    confirmed_source = fixtures.SkillProposalTests.confirmed_source
    propose = fixtures.SkillProposalTests.propose
    accept = fixtures.SkillProposalTests.accept

    def setUp(self):
        fixtures.SkillProposalTests.setUp(self)
        self.path = Path(self.temp.name) / 'competition.sqlite3'

    def call(self, calls):
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.path, self.esco_path)]
        # Child blocks network and OpenAI import before importing the server.
        boot = """import sys,socket,asyncio
# Windows asyncio creates a loopback socketpair during loop construction.
# Construct it before denying all subsequent network connections.
loop=asyncio.new_event_loop()
def denied(*a,**k): raise AssertionError('Network forbidden')
socket.socket.connect=denied
socket.socket.connect_ex=denied
asyncio.new_event_loop=lambda: loop
asyncio.events.new_event_loop=lambda: loop
sys.modules['openai']=None
from competition_agent.mcp_server import main
raise SystemExit(main())
"""
        async def session():
            params = StdioServerParameters(command=sys.executable,
                args=['-B','-c',boot,'--competition-db',str(self.path),'--esco-db',str(self.esco_path)],
                env={'PYTHONPATH':str(fixtures.AGENT/'src'),'PYTHONIOENCODING':'utf-8'})
            async with stdio_client(params) as (read,write):
                async with ClientSession(read,write) as client:
                    await client.initialize()
                    names={t.name for t in (await client.list_tools()).tools}
                    self.assertEqual(names,{'list_competitions','get_competition','get_competition_skills'})
                    out=[]
                    for name,args in calls:
                        response=await client.call_tool(name,args)
                        self.assertFalse(response.isError, response)
                        out.append(json.loads(response.content[0].text))
                    return out
        result=asyncio.run(asyncio.wait_for(session(),30))
        self.assertEqual(before,[hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.path,self.esco_path)])
        return result

    def test_confirmed_missing_empty_and_limit(self):
        cid,sid=self.confirmed_source()
        self.repo.create_competition('draft')
        listing,detail,missing,empty,limit=self.call([
            ('list_competitions',{'limit':1}),('get_competition',{'competition_id':cid}),
            ('get_competition',{'competition_id':999}),('get_competition_skills',{'competition_id':cid}),
            ('list_competitions',{'limit':101})])
        self.assertEqual(len(listing['competitions']),1)
        self.assertEqual(detail['competition']['competition_name'],'合成測試競賽')
        self.assertEqual(detail['groups_status'],'not_recorded')
        self.assertEqual(detail['sources'][0]['source_status'],'confirmed_current')
        self.assertEqual(missing['status'],'not_found')
        self.assertEqual(empty['skills'],[])
        self.assertEqual(limit['status'],'invalid_limit')

    def test_proposals_not_formal_and_accepted_skill(self):
        cid,sid,run,proposals=self.propose()
        self.assertEqual(self.call([('get_competition_skills',{'competition_id':cid})])[0]['skills'],[])
        self.accept(proposals[0])
        skill=self.call([('get_competition_skills',{'competition_id':cid})])[0]['skills'][0]
        self.assertTrue(skill['valid'])
        self.assertEqual(skill['label'],'computer programming')
        self.assertEqual(skill['concept_uri'],self.uri)

    def test_stale_source_not_valid(self):
        cid,sid,run,p=self.propose(); self.accept(p[0])
        with self.db: self.db.execute("UPDATE competition_sources SET clean_content='changed' WHERE source_id=?",(sid,))
        result=self.call([('get_competition_skills',{'competition_id':cid})])[0]
        self.assertFalse(result['skills'][0]['valid'])
        self.assertEqual(result['sources'][0]['source_status'],'needs_review')

    def test_legacy_evidence_not_valid(self):
        cid,sid=self.confirmed_source()
        with self.db: self.db.execute('INSERT INTO competition_skills VALUES (?,?,?,?)',(cid,self.uri,'core','legacy'))
        skill=self.call([('get_competition_skills',{'competition_id':cid})])[0]['skills'][0]
        self.assertFalse(skill['valid']); self.assertEqual(skill['evidence'],'legacy')

    def test_readonly_and_missing_files(self):
        with readers(self.path,self.esco_path) as (db,repo,esco):
            for conn in (db,esco.connection):
                with self.assertRaises(sqlite3.OperationalError): conn.execute('CREATE TABLE forbidden (id INTEGER)')
        missing=Path(self.temp.name)/'missing.sqlite3'
        with self.assertRaises(sqlite3.OperationalError): create_server(missing,self.esco_path)
        with self.assertRaises(sqlite3.OperationalError): create_server(self.path,missing)
        self.assertFalse(missing.exists())
