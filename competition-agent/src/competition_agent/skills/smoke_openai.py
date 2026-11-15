"""Explicit single-submission smoke. Default dry-run; never opens SQLite."""
import argparse
from dataclasses import asdict
from decimal import Decimal
import inspect
import json
from pathlib import Path

from .api_policy import APIConfig, APIPolicyError
from .openai_extractor import OpenAISkillExtractor, OpenAIExtractionError
from .openai_schema import PROMPT, SCHEMA

ROOT = Path(__file__).resolve().parents[3]
SOURCE_PATH = ROOT / "data/test_output_category_4934.json"
STATE_DIR = ROOT / "data/dev/openai-smoke"
COUNTER_VERSION = "utf8-budget-v1"


def utf8_budget(request):
    """Engineering estimate, NOT exact tokens or a billing upper bound."""
    expected = {"model", "reasoning", "store", "max_output_tokens", "input", "text", "service_tier"}
    messages = request.get("input")
    if (set(request) != expected or request["model"] != "gpt-6-luna"
            or request["reasoning"] != {"effort": "none"} or request["store"] is not False
            or request["max_output_tokens"] != 2000 or request["service_tier"] != "default"
            or request["text"] != {"format": {"type": "json_schema", "name": "competition_skills", "strict": True, "schema": SCHEMA}}
            or not isinstance(messages, list) or len(messages) != 2
            or messages[0] != {"role": "system", "content": PROMPT}
            or set(messages[1]) != {"role", "content"} or messages[1]["role"] != "user"
            or not isinstance(messages[1]["content"], str)):
        raise OpenAIExtractionError("SMOKE_REQUEST_INVALID")
    source = json.loads(messages[1]["content"])
    if not isinstance(source, dict) or set(source) != {"title", "clean_content"} or any(not isinstance(v, str) for v in source.values()):
        raise OpenAIExtractionError("SMOKE_REQUEST_INVALID")
    return len(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")) + 1024


def load_source():
    items = json.loads(SOURCE_PATH.read_text(encoding="utf-8"))["items"]
    matches = [s for s in items if str(s.get("pid")) == "108400"
               and s.get("source_url") == "https://www.hwu.edu.tw/Post?PId=108400"]
    if len(matches) != 1:
        raise APIPolicyError("SMOKE_SOURCE_INVALID")
    return matches[0]


def run(*, execute=False, transport=None):
    source = load_source()
    config = APIConfig(max_requests=1, budget_usd="0.002")
    if execute:
        config = APIConfig.from_env()
        config.validate()
        if config.model != "gpt-6-luna" or config.max_requests != 1 or Decimal(config.budget_usd) > Decimal("0.002"):
            raise APIPolicyError("SMOKE_POLICY_INVALID")
        from openai.resources.responses import Responses
        if "service_tier" not in inspect.signature(Responses.create).parameters:
            raise APIPolicyError("SERVICE_TIER_UNSUPPORTED")
    adapter = OpenAISkillExtractor(config, state_dir=STATE_DIR, transport=transport,
        token_counter=utf8_budget, counter_version=COUNTER_VERSION, standard_tier=True)
    if not execute:
        captured = {"estimated_input": utf8_budget(adapter.build_request(source))}
        if captured["estimated_input"] > 6000:
            raise OpenAIExtractionError("INPUT_TOKEN_LIMIT")
        return dict(status="dry_run", strategy=COUNTER_VERSION, **captured, max_requests=1,
                    budget_usd="0.002", reserved_usd=str(config.reservation()))
    claims = adapter.extract(source)
    # Validated claims only, local review artifact; never print raw provider output.
    if claims:
        with (STATE_DIR / "pending-review.json").open("x", encoding="utf-8") as file:
            json.dump({"source_id": "PId108400", "claims": [asdict(c) for c in claims]}, file, ensure_ascii=False)
    return dict(status="needs_review" if claims else "completed", skill_count=len(claims))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-paid-request", action="store_true", help="Explicitly authorize one potentially billed request")
    args = parser.parse_args(argv)
    try:
        result = run(execute=args.execute_paid_request)
    except (APIPolicyError, OpenAIExtractionError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}))
        return 1
    except Exception:
        print(json.dumps({"status": "failed", "error": "SMOKE_FAILED"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
