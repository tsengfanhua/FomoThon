"""Responses API adapter. Lazy SDK creation; default denied; fake transports are injectable."""
from contextlib import nullcontext
import hashlib
import json
import os

from .api_policy import APIPolicy, APIConfig
from .extraction import SkillClaim, validate_claim
from .openai_schema import SCHEMA, PROMPT, VERSION, CLAIM_PROPERTIES


class OpenAIExtractionError(ValueError):
    pass


def count_input_tokens(request):
    """Local estimate including schema/instructions and conservative framing overhead.

    Unknown tokenizer models fail closed. No remote token-count endpoint is called.
    """
    try:
        import tiktoken
        encoder = tiktoken.encoding_for_model(request["model"])
        return len(encoder.encode(json.dumps(request, ensure_ascii=False), disallowed_special=())) + 512
    except Exception:
        raise OpenAIExtractionError("TOKENIZER_UNAVAILABLE") from None


class SDKTransport:
    def __init__(self, config):
        self.config = config

    def create(self, request):
        # No SDK import/client creation until after policy, token and budget checks.
        self.config.validate()
        from openai import OpenAI
        with OpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=0,
                    timeout=self.config.timeout_seconds, base_url="https://api.openai.com/v1") as client:
            return client.responses.create(**request).model_dump()


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise OpenAIExtractionError("INVALID_JSON")
        result[key] = value
    return result


def parse_claims(response, source):
    if response.get("status") != "completed":
        raise OpenAIExtractionError("INCOMPLETE_RESPONSE")
    texts = []
    for output in response.get("output", []):
        if output.get("type") == "reasoning":
            continue
        if output.get("type") != "message":
            raise OpenAIExtractionError("UNEXPECTED_OUTPUT")
        for content in output.get("content", []):
            if content.get("type") == "refusal":
                raise OpenAIExtractionError("REFUSED")
            if content.get("type") != "output_text":
                raise OpenAIExtractionError("UNEXPECTED_OUTPUT")
            texts.append(content.get("text"))
    if len(texts) != 1 or not isinstance(texts[0], str):
        raise OpenAIExtractionError("INVALID_RESPONSE")
    try:
        data = json.loads(texts[0], object_pairs_hook=_unique_keys)
    except (ValueError, TypeError):
        raise OpenAIExtractionError("INVALID_JSON") from None
    if not isinstance(data, dict) or set(data) != {"skills"} or not isinstance(data["skills"], list) or len(data["skills"]) > 8:
        raise OpenAIExtractionError("SCHEMA_VIOLATION")
    claims = []
    for item in data["skills"]:
        if not isinstance(item, dict) or set(item) != set(CLAIM_PROPERTIES):
            raise OpenAIExtractionError("SCHEMA_VIOLATION")
        for name, limit in (("skill_name", 100), ("quote", 1000), ("reason", 500)):
            if not isinstance(item[name], str) or not item[name].strip() or len(item[name]) > limit:
                raise OpenAIExtractionError("SCHEMA_VIOLATION")
        terms = item["search_terms_en"]
        if (not isinstance(terms, list) or len(terms) > 3
                or any(not isinstance(t, str) or not t.strip() or len(t) > 100 for t in terms)
                or item["field"] not in ("title", "clean_content")
                or (item["group_name"] is not None and (not isinstance(item["group_name"], str) or len(item["group_name"]) > 100))):
            raise OpenAIExtractionError("SCHEMA_VIOLATION")
        text, quote = source[item["field"]], item["quote"]
        start = text.find(quote)
        if start < 0 or text.find(quote, start + 1) >= 0:
            raise OpenAIExtractionError("QUOTE_NOT_UNIQUE_OR_MISSING")
        claim = SkillClaim(skill_name=item["skill_name"], quote=quote, start=start, end=start+len(quote),
            field=item["field"], evidence_level=item["evidence_level"], scope=item["scope"],
            reason=item["reason"], group_name=item["group_name"], suggested_search_terms=tuple(terms))
        try:
            validate_claim(claim, source)
        except (ValueError, TypeError):
            raise OpenAIExtractionError("EVIDENCE_INVALID") from None
        claims.append(claim)
    return claims


class OpenAISkillExtractor:
    method = "openai"

    def __init__(self, config=None, *, state_dir="agents/competition_agent/data/dev/openai",
                 transport=None, token_counter=None, counter_version="tiktoken-json-512-v1",
                 standard_tier=False):
        self.config = config if config is not None else APIConfig.from_env()
        self.policy = APIPolicy(self.config, state_dir)
        self.transport = transport if transport is not None else SDKTransport(self.config)
        self.token_counter = token_counter if token_counter is not None else count_input_tokens
        self.counter_version = counter_version
        self.standard_tier = standard_tier
        self.version = VERSION + ":" + hashlib.sha256(json.dumps(
            [PROMPT, SCHEMA, self.config.model, self.config.max_input_tokens, self.config.max_output_tokens, "none", counter_version, standard_tier],
            sort_keys=True).encode()).hexdigest()

    def operation(self):
        return self.policy.operation()

    def build_request(self, source):
        request = dict(model=self.config.model, reasoning={"effort": "none"}, store=False,
            max_output_tokens=self.config.max_output_tokens,
            input=[{"role": "system", "content": PROMPT}, {"role": "user", "content": json.dumps(
                {k: source[k] for k in ("title", "clean_content")}, ensure_ascii=False)}],
            text={"format": {"type": "json_schema", "name": "competition_skills", "strict": True, "schema": SCHEMA}})
        if self.standard_tier:
            request["service_tier"] = "default"
        return request

    def extract(self, source):
        with nullcontext() if self.policy.owned() else self.operation():
            request = self.build_request(source)
            try:
                count = self.token_counter(request)
            except Exception:
                raise OpenAIExtractionError("TOKENIZER_UNAVAILABLE") from None
            if type(count) is not int or count < 0 or count > self.config.max_input_tokens:
                raise OpenAIExtractionError("INPUT_TOKEN_LIMIT")
            request_hash = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
            self.policy.reserve(request_hash)
            usage = None
            try:
                response = self.transport.create(request)
            except Exception as exc:
                code = "TIMEOUT" if isinstance(exc, TimeoutError) or type(exc).__name__ == "APITimeoutError" else "TRANSPORT_ERROR"
                self.policy.finish(request_hash, error=code)
                raise OpenAIExtractionError(code) from None
            try:
                if self.standard_tier and response.get("service_tier") != "default":
                    raise OpenAIExtractionError("SERVICE_TIER_UNCONFIRMED")
                raw_usage = response.get("usage")
                if self.standard_tier and not isinstance(raw_usage, dict):
                    raise OpenAIExtractionError("INVALID_USAGE")
                if isinstance(raw_usage, dict):
                    measured = {k: raw_usage.get(k) for k in ("input_tokens", "output_tokens")}
                    if any(type(v) is not int or v < 0 for v in measured.values()):
                        raise OpenAIExtractionError("INVALID_USAGE")
                    usage = measured
                    if usage["input_tokens"] > self.config.max_input_tokens or usage["output_tokens"] > self.config.max_output_tokens:
                        raise OpenAIExtractionError("ACTUAL_TOKEN_LIMIT")
                claims = parse_claims(response, source)
            except Exception as exc:
                # Never persist raw provider output or exception text.
                safe = str(exc) if isinstance(exc, OpenAIExtractionError) else "INVALID_RESPONSE"
                self.policy.finish(request_hash, error=safe, usage=usage)
                raise OpenAIExtractionError(safe) from None
            self.policy.finish(request_hash, usage=usage)
            return claims
