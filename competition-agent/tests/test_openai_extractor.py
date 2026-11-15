"""Fake Responses transport only. Network is blocked for every test in this module."""
from dataclasses import replace
import copy
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

AGENT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT / "src"))
from competition_agent.skills.api_policy import APIConfig, APIPolicy, APIPolicyError
from competition_agent.skills.openai_extractor import OpenAISkillExtractor, OpenAIExtractionError, SDKTransport
from competition_agent.skills.openai_schema import SCHEMA
from competition_agent.skills.extraction import controlled_terms
from competition_agent.skills.proposals import ProposalConflict
import test_skill_proposals as fixtures

SOURCE = {"title": "合成測試", "clean_content": fixtures.SYNTHETIC}
CLAIM = dict(skill_name="程式設計", field="clean_content", quote=fixtures.QUOTE,
             evidence_level="explicit", scope="competition_wide", group_name=None,
             reason="合成測試明示要求", search_terms_en=["computer programming"])


def response(skills=None):
    return dict(status="completed", output=[dict(type="message", content=[dict(
        type="output_text", text=json.dumps({"skills": [] if skills is None else skills}, ensure_ascii=False))])],
        usage={"input_tokens": 300, "output_tokens": 100})


class FakeTransport:
    def __init__(self, reply=None, error=None, callback=None):
        self.reply = response() if reply is None else reply
        self.error = error
        self.callback = callback
        self.requests = []

    def create(self, request):
        self.requests.append(copy.deepcopy(request))
        if self.callback:
            self.callback()
        if self.error:
            raise self.error
        return copy.deepcopy(self.reply)


def block_network(test):
    for name in ("connect", "connect_ex"):
        guard = patch.object(socket.socket, name, side_effect=AssertionError("Network forbidden in offline tests"))
        guard.start()
        test.addCleanup(guard.stop)


class OpenAIAdapterTests(unittest.TestCase):
    def setUp(self):
        block_network(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        # Explicitly not a credential; only tests environment lookup and non-disclosure.
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "offline-placeholder", "COMPETITION_ENABLE_OPENAI": "0"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.config = APIConfig(enabled=True, max_requests=2, budget_usd="0.01")

    def adapter(self, reply=None, *, error=None, config=None, count=300):
        transport = FakeTransport(reply, error)
        return OpenAISkillExtractor(config or self.config, state_dir=self.state,
                                    transport=transport, token_counter=lambda _: count), transport

    def test_default_disabled_with_key_present(self):
        transport = FakeTransport()
        adapter = OpenAISkillExtractor(state_dir=self.state, transport=transport)
        with self.assertRaisesRegex(APIPolicyError, "API_DISABLED"):
            adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])
        self.assertFalse((self.state / "calls.jsonl").exists())

    def test_no_key_no_calls(self):
        adapter, transport = self.adapter()
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            with self.assertRaisesRegex(APIPolicyError, "API_KEY_REQUIRED"):
                adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])

    def test_env_requires_explicit_model_and_positive_limits(self):
        with patch.dict(os.environ, {"COMPETITION_ENABLE_OPENAI": "1", "COMPETITION_OPENAI_MODEL": ""}):
            with self.assertRaisesRegex(APIPolicyError, "MODEL_REQUIRED"):
                APIConfig.from_env()
        for config in (APIConfig(enabled=True), replace(self.config, budget_usd="0"),
                       replace(self.config, model=""), replace(self.config, max_requests=-1),
                       replace(self.config, budget_usd="NaN")):
            with self.subTest(config=config):
                adapter, transport = self.adapter(config=config)
                with self.assertRaises(APIPolicyError):
                    adapter.extract(SOURCE)
                self.assertEqual(transport.requests, [])

    def test_strict_schema_and_default_request(self):
        adapter, transport = self.adapter(response([CLAIM]))
        claims = adapter.extract(SOURCE)
        request = transport.requests[0]
        self.assertEqual(request["model"], "gpt-6-luna")
        self.assertEqual(request["reasoning"], {"effort": "none"})
        self.assertTrue(request["text"]["format"]["strict"])
        self.assertFalse(request["store"])
        self.assertEqual(request["max_output_tokens"], 2000)
        self.assertNotIn("tools", request)
        self.assertFalse(SCHEMA["additionalProperties"])
        fields = SCHEMA["properties"]["skills"]["items"]
        self.assertFalse(fields["additionalProperties"])
        self.assertEqual(set(fields["required"]), set(fields["properties"]))
        self.assertTrue({"concept_uri", "importance", "reviewer"}.isdisjoint(fields["properties"]))
        self.assertEqual(SOURCE["clean_content"][claims[0].start:claims[0].end], fixtures.QUOTE)

    def test_empty_array_is_success(self):
        adapter, transport = self.adapter()
        self.assertEqual(adapter.extract(SOURCE), [])
        self.assertEqual(len(transport.requests), 1)
        events = [json.loads(line) for line in (self.state / "calls.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["event"], "completed")

    def test_refusal(self):
        reply = response()
        reply["output"][0]["content"] = [{"type": "refusal", "refusal": "provider text"}]
        adapter, _ = self.adapter(reply)
        with self.assertRaisesRegex(OpenAIExtractionError, "REFUSED"):
            adapter.extract(SOURCE)

    def test_incomplete_response(self):
        reply = response()
        reply["status"] = "incomplete"
        adapter, _ = self.adapter(reply)
        with self.assertRaisesRegex(OpenAIExtractionError, "INCOMPLETE_RESPONSE"):
            adapter.extract(SOURCE)

    def test_invalid_json(self):
        reply = response()
        reply["output"][0]["content"][0]["text"] = "not JSON"
        adapter, _ = self.adapter(reply)
        with self.assertRaisesRegex(OpenAIExtractionError, "INVALID_JSON"):
            adapter.extract(SOURCE)

    def test_duplicate_json_keys_rejected(self):
        reply = response()
        reply["output"][0]["content"][0]["text"] = '{"skills":[],"skills":[]}'
        adapter, _ = self.adapter(reply)
        with self.assertRaisesRegex(OpenAIExtractionError, "INVALID_JSON"):
            adapter.extract(SOURCE)

    def test_forbidden_fields_are_rejected(self):
        for field in ("concept_uri", "importance", "reviewer"):
            with self.subTest(field=field):
                adapter, _ = self.adapter(response([dict(CLAIM, **{field: "forbidden"})]))
                adapter.policy.state_dir = self.state / field
                with self.assertRaisesRegex(OpenAIExtractionError, "SCHEMA_VIOLATION"):
                    adapter.extract(SOURCE)

    def test_missing_and_ambiguous_quotes(self):
        for text in ("no matching quote", fixtures.SYNTHETIC + fixtures.QUOTE):
            with self.subTest(text=text):
                adapter, _ = self.adapter(response([CLAIM]))
                with self.assertRaisesRegex(OpenAIExtractionError, "QUOTE_NOT_UNIQUE_OR_MISSING"):
                    adapter.extract(dict(SOURCE, clean_content=text))

    def test_unicode_offsets_use_local_python_indices(self):
        source = dict(SOURCE, clean_content="🎨\r\n" + fixtures.SYNTHETIC)
        adapter, _ = self.adapter(response([CLAIM]))
        claim = adapter.extract(source)[0]
        self.assertEqual(claim.start, source["clean_content"].index(fixtures.QUOTE))

    def test_unknown_search_words_retained_not_used(self):
        adapter, _ = self.adapter(response([dict(CLAIM, search_terms_en=["machine learning"])]))
        claim = adapter.extract(SOURCE)[0]
        self.assertEqual(claim.suggested_search_terms, ("machine learning",))
        self.assertEqual(controlled_terms(claim), ())

    def test_known_search_words_filtered(self):
        adapter, _ = self.adapter(response([dict(CLAIM, search_terms_en=["COMPUTER PROGRAMMING", "machine learning"])]))
        self.assertEqual(controlled_terms(adapter.extract(SOURCE)[0]), ("computer programming",))

    def test_invalid_enum_and_group_evidence(self):
        for index, change in enumerate(({"evidence_level": "certain"}, {"scope": "group", "group_name": "不存在組別"})):
            adapter, _ = self.adapter(response([dict(CLAIM, **change)]))
            adapter.policy.state_dir = self.state / str(index)
            with self.assertRaisesRegex(OpenAIExtractionError, "EVIDENCE_INVALID"):
                adapter.extract(SOURCE)

    def test_timeout_no_retry_and_repeat_blocked(self):
        adapter, transport = self.adapter(error=TimeoutError("do not log provider details"))
        with self.assertRaisesRegex(OpenAIExtractionError, "TIMEOUT"):
            adapter.extract(SOURCE)
        with self.assertRaisesRegex(APIPolicyError, "REQUEST_ALREADY_SUBMITTED"):
            adapter.extract(SOURCE)
        self.assertEqual(len(transport.requests), 1)

    def test_transport_error_sanitized(self):
        adapter, _ = self.adapter(error=RuntimeError(os.environ["OPENAI_API_KEY"]))
        with self.assertRaisesRegex(OpenAIExtractionError, "TRANSPORT_ERROR") as raised:
            adapter.extract(SOURCE)
        logs = (self.state / "calls.jsonl").read_text()
        self.assertNotIn("offline-placeholder", logs + str(raised.exception))
        self.assertNotIn(fixtures.QUOTE, logs)

    def test_token_limit_before_transport(self):
        adapter, transport = self.adapter(count=6001)
        with self.assertRaisesRegex(OpenAIExtractionError, "INPUT_TOKEN_LIMIT"):
            adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])

    def test_unknown_tokenizer_fails_closed(self):
        adapter, transport = self.adapter()
        def fail(_):
            raise ValueError("unknown encoding")
        adapter.token_counter = fail
        with self.assertRaisesRegex(OpenAIExtractionError, "TOKENIZER_UNAVAILABLE"):
            adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])

    def test_budget_limit_no_transport(self):
        adapter, transport = self.adapter(config=replace(self.config, budget_usd="0.00001"))
        with self.assertRaisesRegex(APIPolicyError, "BUDGET_LIMIT"):
            adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])

    def test_request_limit_persists_across_instances(self):
        config = replace(self.config, max_requests=1)
        adapter, _ = self.adapter(config=config)
        adapter.extract(SOURCE)
        second, transport = self.adapter(config=config)
        with self.assertRaisesRegex(APIPolicyError, "REQUEST_LIMIT"):
            second.extract(dict(SOURCE, title="different"))
        self.assertEqual(transport.requests, [])

    def test_corrupt_ledger_fails_closed(self):
        (self.state / "calls.jsonl").write_text("corrupt", encoding="utf-8")
        adapter, transport = self.adapter()
        with self.assertRaisesRegex(APIPolicyError, "INVALID_CALL_LEDGER"):
            adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])

    def test_existing_session_lock_denies_second_policy(self):
        policy = APIPolicy(self.config, self.state)
        second = APIPolicy(self.config, self.state)
        with policy.operation():
            with self.assertRaisesRegex(APIPolicyError, "PARALLEL_OR_UNRESOLVED_SESSION"):
                with second.operation():
                    self.fail("should not enter")

    def test_parallel_thread_denied(self):
        policy = APIPolicy(self.config, self.state)
        errors = []
        def concurrent():
            try:
                with policy.operation():
                    errors.append("unexpected success")
            except APIPolicyError as exc:
                errors.append(str(exc))
        with policy.operation():
            thread = threading.Thread(target=concurrent)
            thread.start()
            thread.join(timeout=2)
        self.assertEqual(errors, ["PARALLEL_USE_DENIED"])

    def test_custom_model_needs_rates_no_fallback(self):
        config = replace(self.config, model="explicit-custom-model")
        adapter, transport = self.adapter(config=config)
        with self.assertRaises(APIPolicyError):
            adapter.extract(SOURCE)
        self.assertEqual(transport.requests, [])
        adapter, transport = self.adapter(config=replace(config, input_rate="1", output_rate="1"))
        adapter.extract(SOURCE)
        self.assertEqual(transport.requests[0]["model"], "explicit-custom-model")

    def test_invalid_usage_never_logs_arbitrary_values(self):
        reply = response()
        reply["usage"]["input_tokens"] = "offline-placeholder"
        adapter, _ = self.adapter(reply)
        with self.assertRaisesRegex(OpenAIExtractionError, "INVALID_USAGE"):
            adapter.extract(SOURCE)
        self.assertNotIn("offline-placeholder", (self.state / "calls.jsonl").read_text())

    def test_actual_token_excess_blocks_further_calls(self):
        reply = response()
        reply["usage"]["input_tokens"] = 6001
        adapter, transport = self.adapter(reply)
        with self.assertRaisesRegex(OpenAIExtractionError, "ACTUAL_TOKEN_LIMIT"):
            adapter.extract(SOURCE)
        with self.assertRaisesRegex(APIPolicyError, "USAGE_RECONCILIATION_REQUIRED"):
            adapter.extract(dict(SOURCE, title="other"))
        self.assertEqual(len(transport.requests), 1)

    def test_sdk_configuration_with_fake_sdk_no_network(self):
        calls = {}
        class FakeClient:
            def __init__(self, **kwargs):
                calls.update(kwargs)
                self.responses = self
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def create(self, **kwargs):
                return types.SimpleNamespace(model_dump=lambda: response())
        with patch.dict(sys.modules, {"openai": types.SimpleNamespace(OpenAI=FakeClient)}):
            result = SDKTransport(self.config).create({"model": self.config.model})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(calls["max_retries"], 0)
        self.assertEqual(calls["timeout"], 30)
        self.assertEqual(calls["base_url"], "https://api.openai.com/v1")
        self.assertEqual(calls["api_key"], os.environ["OPENAI_API_KEY"])


class OpenAIProposalIntegrationTests(unittest.TestCase):
    confirmed_source = fixtures.SkillProposalTests.confirmed_source
    accept = fixtures.SkillProposalTests.accept

    def setUp(self):
        block_network(self)
        fixtures.SkillProposalTests.setUp(self)
        env = patch.dict(os.environ, {"OPENAI_API_KEY": "offline-placeholder"})
        env.start()
        self.addCleanup(env.stop)
        self.transport = FakeTransport(response([CLAIM]))
        self.adapter = OpenAISkillExtractor(APIConfig(enabled=True, max_requests=2, budget_usd="0.01"),
            state_dir=Path(self.temp.name)/"api", transport=self.transport, token_counter=lambda _: 300)

    def test_fake_api_full_flow_and_existing_cache(self):
        cid, sid = self.confirmed_source()
        self.transport.callback = lambda: self.assertFalse(self.db.in_transaction)
        run = self.proposals.extract(cid, sid, self.adapter)
        self.assertEqual(dict(run), dict(self.proposals.extract(cid, sid, self.adapter)))
        self.assertEqual(len(self.transport.requests), 1)
        proposal = self.proposals.list_proposals(run["run_id"])[0]
        self.accept(proposal)
        self.assertEqual(len(self.repo.list_skills(cid)), 1)

    def test_source_changes_during_call_rejected(self):
        cid, sid = self.confirmed_source()
        def mutate():
            self.assertFalse(self.db.in_transaction)
            with self.db:
                self.db.execute("UPDATE competition_sources SET clean_content=clean_content || '變更' WHERE source_id=?", (sid,))
        self.transport.callback = mutate
        with self.assertRaises(ProposalConflict):
            self.proposals.extract(cid, sid, self.adapter)
        self.assertEqual(self.db.execute("SELECT count(*) FROM skill_proposals").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM skill_extraction_runs").fetchone()[0], "failed")

    def test_classification_revision_changes_during_call(self):
        cid, sid = self.confirmed_source()
        def mutate():
            with self.db:
                self.db.execute("UPDATE source_classifications SET revision=revision+1 WHERE source_id=?", (sid,))
        self.transport.callback = mutate
        with self.assertRaises(ProposalConflict):
            self.proposals.extract(cid, sid, self.adapter)

    def test_timeout_saved_as_failed_not_empty_success(self):
        cid, sid = self.confirmed_source()
        self.transport.error = TimeoutError("provider error")
        with self.assertRaisesRegex(OpenAIExtractionError, "TIMEOUT"):
            self.proposals.extract(cid, sid, self.adapter)
        row = self.db.execute("SELECT * FROM skill_extraction_runs").fetchone()
        self.assertEqual((row["status"], row["error"]), ("failed", "TIMEOUT"))

    def test_real_yushow_fake_empty_response(self):
        from competition_agent.adapters.crawler_json import import_category_json
        import_category_json(fixtures.ROOT / "data/test_output_category_4934.json", self.repo)
        self.classifier.classify_hwu_sources()
        sid = self.db.execute("SELECT source_id FROM competition_sources WHERE source_url=?",
            ("https://www.hwu.edu.tw/Post?PId=108400",)).fetchone()[0]
        row = self.classifier.get(sid)
        row = self.classifier.confirm_classification(sid, expected_revision=row["revision"], category="competition_call",
            reviewer="test-human", note="真實原文，離線假回應")
        cid = self.classifier.create_competition_from_review(sid, expected_revision=row["revision"],
            competition_name="第24屆育秀盃創意獎", edition="第24屆", name_evidence="公告標題", reviewer="test-human")
        self.transport.reply = response()
        run = self.proposals.extract(cid, sid, self.adapter)
        self.assertEqual(run["proposal_count"], 0)
        self.assertEqual(self.repo.list_skills(cid), [])

    def test_unknown_translation_stays_pending(self):
        cid, sid = self.confirmed_source()
        self.transport.reply = response([dict(CLAIM, search_terms_en=["machine learning"])])
        run = self.proposals.extract(cid, sid, self.adapter)
        proposal = self.proposals.list_proposals(run["run_id"])[0]
        self.assertEqual(json.loads(proposal["candidates_json"]), [])
        self.assertEqual(json.loads(proposal["claim_json"])["suggested_search_terms"], ["machine learning"])
        with self.assertRaises(ProposalConflict):
            self.accept(proposal)


class LiveSmokeTests(unittest.TestCase):
    @unittest.skip("Real API smoke is unconditionally disabled; separate authorization and manual enablement required")
    def test_real_api_yushow_zero_skills(self):
        # No SQLite writes. Intentionally cannot be enabled by environment alone.
        source = next(item for item in json.loads((fixtures.ROOT / "data/test_output_category_4934.json").read_text(
            encoding="utf-8"))["items"] if item["pid"] == "108400")
        self.assertEqual(OpenAISkillExtractor().extract(source), [])


if __name__ == "__main__":
    unittest.main()
