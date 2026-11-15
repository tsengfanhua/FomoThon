"""Default-deny API policy and conservative local request ledger.

One configured state directory must be shared by all callers. Exclusive lock files
REJECT concurrency, not coordinate workers. Crash leftovers require manual inspection.
Reservations are never refunded; a submitted request hash cannot be replayed automatically.
"""
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
import json
import os
from pathlib import Path
import threading
from datetime import datetime, timezone


class APIPolicyError(ValueError):
    """Only fixed safe messages, never SDK exceptions, environment values or prompts."""


@dataclass(frozen=True)
class APIConfig:
    enabled: bool = False
    model: str = "gpt-6-luna"
    max_requests: int = 0
    budget_usd: str = "0"
    max_input_tokens: int = 6000
    max_output_tokens: int = 2000
    timeout_seconds: float = 30.0
    # Conservative cached-write input rate, Standard output rate; USD / million.
    input_rate: str = "0.125"
    output_rate: str = "0.50"

    @classmethod
    def from_env(cls):
        enabled = os.environ.get("COMPETITION_ENABLE_OPENAI") == "1"
        if not enabled:
            return cls()
        if not os.environ.get("COMPETITION_OPENAI_MODEL", "").strip():
            raise APIPolicyError("MODEL_REQUIRED")
        try:
            return cls(enabled=True, model=os.environ["COMPETITION_OPENAI_MODEL"],
                       max_requests=int(os.environ.get("COMPETITION_OPENAI_MAX_REQUESTS", "0")),
                       budget_usd=os.environ.get("COMPETITION_OPENAI_BUDGET_USD", "0"))
        except (ValueError, TypeError):
            raise APIPolicyError("INVALID_POLICY") from None

    def validate(self):
        if self.enabled is not True:
            raise APIPolicyError("API_DISABLED")
        if not os.environ.get("OPENAI_API_KEY", "").strip():
            raise APIPolicyError("API_KEY_REQUIRED")
        try:
            numbers = [Decimal(x) for x in (self.budget_usd, self.input_rate, self.output_rate)]
            if (any(not n.is_finite() or n <= 0 for n in numbers)
                    or not isinstance(self.model, str) or not self.model.strip()
                    or type(self.max_requests) is not int or self.max_requests <= 0
                    or type(self.max_input_tokens) is not int or not 1 <= self.max_input_tokens <= 6000
                    or type(self.max_output_tokens) is not int or not 1 <= self.max_output_tokens <= 2000
                    or not 0 < self.timeout_seconds <= 120):
                raise ValueError()
            if self.model != "gpt-6-luna" and (self.input_rate, self.output_rate) == ("0.125", "0.50"):
                raise ValueError()  # Custom model needs explicitly reviewed pricing, never Luna defaults.
        except Exception:
            raise APIPolicyError("INVALID_POLICY") from None

    def reservation(self):
        return (Decimal(self.max_input_tokens) * Decimal(self.input_rate)
                + Decimal(self.max_output_tokens) * Decimal(self.output_rate)) / Decimal(1000000)


class APIPolicy:
    def __init__(self, config: APIConfig, state_dir: str | Path):
        self.config = config
        self.state_dir = Path(state_dir).resolve()
        self._busy = threading.Lock()
        self._owner = None
        self._pid = os.getpid()

    @contextmanager
    def operation(self):
        self.config.validate()
        if self._pid != os.getpid() or not self._busy.acquire(blocking=False):
            raise APIPolicyError("PARALLEL_USE_DENIED")
        lock_path = self.state_dir / "api.lock"
        acquired = False
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            try:
                with lock_path.open("x", encoding="utf-8") as file:
                    file.write(str(os.getpid()))
                acquired = True
            except FileExistsError:
                raise APIPolicyError("PARALLEL_OR_UNRESOLVED_SESSION") from None
            self._owner = threading.get_ident()
            yield
        finally:
            self._owner = None
            if acquired:
                lock_path.unlink()
            self._busy.release()

    def owned(self):
        return self._pid == os.getpid() and self._owner == threading.get_ident()

    def _events(self):
        path = self.state_dir / "calls.jsonl"
        if not path.exists():
            return []
        try:
            events = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            for event in events:
                if not isinstance(event, dict) or event.get("event") not in {"reserved", "completed", "failed"}:
                    raise ValueError()
                if event["event"] == "reserved":
                    amount = Decimal(event["reserved_usd"])
                    if not amount.is_finite() or amount <= 0 or not isinstance(event["request_hash"], str):
                        raise ValueError()
            return events
        except Exception:
            raise APIPolicyError("INVALID_CALL_LEDGER") from None

    def _append(self, event):
        if not self.owned():
            raise APIPolicyError("SESSION_REQUIRED")
        event["time"] = datetime.now(timezone.utc).isoformat()
        with (self.state_dir / "calls.jsonl").open("a", encoding="utf-8") as file:
            file.write(json.dumps(event, sort_keys=True) + "\n")
            file.flush()
            os.fsync(file.fileno())

    def reserve(self, request_hash):
        if not self.owned():
            raise APIPolicyError("SESSION_REQUIRED")
        events = self._events()
        if any(e.get("error") == "ACTUAL_TOKEN_LIMIT" for e in events):
            raise APIPolicyError("USAGE_RECONCILIATION_REQUIRED")
        entries = [e for e in events if e["event"] == "reserved"]
        if any(e["request_hash"] == request_hash for e in entries):
            raise APIPolicyError("REQUEST_ALREADY_SUBMITTED")
        if len(entries) >= self.config.max_requests:
            raise APIPolicyError("REQUEST_LIMIT")
        cost = self.config.reservation()
        if sum((Decimal(e["reserved_usd"]) for e in entries), Decimal(0)) + cost > Decimal(self.config.budget_usd):
            raise APIPolicyError("BUDGET_LIMIT")
        self._append(dict(event="reserved", request_hash=request_hash, reserved_usd=str(cost)))

    def finish(self, request_hash, *, error=None, usage=None):
        # No arbitrary strings, response IDs, source text or exception messages are logged.
        self._append(dict(event="failed" if error else "completed", request_hash=request_hash,
                          error=error, usage=usage))
