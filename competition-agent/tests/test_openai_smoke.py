"""Offline smoke entry tests. All sockets and SQLite connections forbidden."""
import copy
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import test_openai_extractor as fixtures
from competition_agent.skills import smoke_openai as smoke
from competition_agent.skills.api_policy import APIConfig, APIPolicyError
from competition_agent.skills.openai_extractor import OpenAISkillExtractor, OpenAIExtractionError, count_input_tokens


class SmokeTests(unittest.TestCase):
    def setUp(self):
        fixtures.block_network(self)
        guard = patch.object(sqlite3, "connect", side_effect=AssertionError("SQLite forbidden"))
        guard.start(); self.addCleanup(guard.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "ledger"
        for guard in (patch.object(smoke, "STATE_DIR", self.state), patch.dict(os.environ, {
            "OPENAI_API_KEY": "offline-placeholder", "COMPETITION_ENABLE_OPENAI": "1",
            "COMPETITION_OPENAI_MODEL": "gpt-6-luna", "COMPETITION_OPENAI_MAX_REQUESTS": "1",
            "COMPETITION_OPENAI_BUDGET_USD": "0.002"})):
            guard.start(); self.addCleanup(guard.stop)
        self.reply = dict(fixtures.response(), service_tier="default")
        self.transport = fixtures.FakeTransport(self.reply)

    def test_dry_run_no_transport_or_files(self):
        result = smoke.run(transport=self.transport)
        self.assertEqual(result["status"], "dry_run")
        self.assertLess(result["estimated_input"], 6000)
        self.assertEqual(self.transport.requests, [])
        self.assertFalse(self.state.exists())

    def request(self, text):
        return OpenAISkillExtractor(standard_tier=True).build_request({"title": "", "clean_content": text})

    def test_utf8_english_chinese_emoji(self):
        for text in ("English", "中文", "😀"):
            r = self.request(text)
            self.assertEqual(smoke.utf8_budget(r), len(json.dumps(r, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())+1024)

    def test_request_shape_restrictions(self):
        for key,value in (("tools",[]),("previous_response_id","x"),("service_tier","auto"),("model","other")):
            r=self.request("test"); r[key]=value
            with self.assertRaises(OpenAIExtractionError): smoke.utf8_budget(r)

    def test_boundary_and_overflow(self):
        base=smoke.utf8_budget(self.request(""))
        for limit in (6000,6001):
            adapter=OpenAISkillExtractor(APIConfig(enabled=True,max_requests=1,budget_usd="0.002"),
                state_dir=self.state, transport=self.transport, token_counter=smoke.utf8_budget,
                counter_version=smoke.COUNTER_VERSION,standard_tier=True)
            source={"title":"","clean_content":"a"*(limit-base)}
            self.assertEqual(smoke.utf8_budget(adapter.build_request(source)),limit)
            if limit==6000: self.assertEqual(adapter.extract(source),[])
            else:
                with self.assertRaisesRegex(OpenAIExtractionError,"INPUT_TOKEN_LIMIT"): adapter.extract(source)
        self.assertEqual(len(self.transport.requests),1)

    def test_default_counter_still_fails_closed(self):
        with patch('tiktoken.encoding_for_model', side_effect=KeyError()):
            with self.assertRaisesRegex(OpenAIExtractionError,'TOKENIZER_UNAVAILABLE'): count_input_tokens(self.request('test'))

    def test_counter_versions_separate(self):
        self.assertNotEqual(OpenAISkillExtractor().version,OpenAISkillExtractor(counter_version=smoke.COUNTER_VERSION).version)

    def test_missing_required_environment(self):
        for key in ('OPENAI_API_KEY','COMPETITION_ENABLE_OPENAI','COMPETITION_OPENAI_MODEL','COMPETITION_OPENAI_MAX_REQUESTS','COMPETITION_OPENAI_BUDGET_USD'):
            with self.subTest(key=key), patch.dict(os.environ,{key:''}):
                with self.assertRaises(APIPolicyError): smoke.run(execute=True,transport=self.transport)
        self.assertEqual(self.transport.requests,[])

    def test_budget_and_request_limits(self):
        for key,value in (('COMPETITION_OPENAI_BUDGET_USD','0.001'),('COMPETITION_OPENAI_BUDGET_USD','0.003'),('COMPETITION_OPENAI_MAX_REQUESTS','2'),('COMPETITION_OPENAI_MODEL','other')):
            with patch.dict(os.environ,{key:value}):
                with self.assertRaises(APIPolicyError): smoke.run(execute=True,transport=self.transport)
        self.assertEqual(self.transport.requests,[])

    def test_success_and_replay_denied(self):
        self.assertEqual(smoke.run(execute=True,transport=self.transport),dict(status='completed',skill_count=0))
        self.assertEqual(self.transport.requests[0]['service_tier'],'default')
        with self.assertRaises(APIPolicyError): smoke.run(execute=True,transport=self.transport)
        self.assertEqual(len(self.transport.requests),1)

    def test_timeout_no_retry(self):
        self.transport.error=TimeoutError('secret provider detail')
        with self.assertRaisesRegex(OpenAIExtractionError,'^TIMEOUT$'): smoke.run(execute=True,transport=self.transport)
        with self.assertRaises(APIPolicyError): smoke.run(execute=True,transport=self.transport)
        self.assertEqual(len(self.transport.requests),1)

    def test_refusal(self):
        self.transport.reply['output'][0]['content']=[dict(type='refusal',refusal='private')]
        with self.assertRaisesRegex(OpenAIExtractionError,'^REFUSED$'): smoke.run(execute=True,transport=self.transport)

    def test_invalid_json(self):
        self.transport.reply['output'][0]['content'][0]['text']='invalid'
        with self.assertRaisesRegex(OpenAIExtractionError,'^INVALID_JSON$'): smoke.run(execute=True,transport=self.transport)

    def test_incomplete(self):
        self.transport.reply['status']='incomplete'
        with self.assertRaisesRegex(OpenAIExtractionError,'^INCOMPLETE_RESPONSE$'): smoke.run(execute=True,transport=self.transport)

    def test_unconfirmed_tier(self):
        self.transport.reply['service_tier']='priority'
        with self.assertRaisesRegex(OpenAIExtractionError,'SERVICE_TIER_UNCONFIRMED'): smoke.run(execute=True,transport=self.transport)

    def test_claims_saved_pending_not_printed_or_accepted(self):
        self.transport.reply=dict(fixtures.response([fixtures.CLAIM]),service_tier='default')
        with patch.object(smoke,'load_source',return_value=fixtures.SOURCE):
            self.assertEqual(smoke.run(execute=True,transport=self.transport),dict(status='needs_review',skill_count=1))
        self.assertEqual(len(json.loads((self.state/'pending-review.json').read_text(encoding='utf-8'))['claims']),1)

    def test_cli_defaults_dry_run(self):
        with patch.object(smoke,'run',return_value={'status':'dry_run'}) as run, patch('builtins.print'):
            self.assertEqual(smoke.main([]),0)
            run.assert_called_once_with(execute=False)
