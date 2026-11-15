"""不記錄輸入或模型文字的執行事件。"""
from time import perf_counter
from uuid import uuid4


class Trace:
    def __init__(self):
        self.run_id = str(uuid4())
        self.events = []

    def record(self, step, status, started, source=None, error_code=None):
        item = {"run_id": self.run_id, "step": step, "status": status,
                "duration_ms": round((perf_counter() - started) * 1000, 3)}
        if source:
            item["source"] = source
        if error_code:
            item["error_code"] = error_code
        self.events.append(item)
