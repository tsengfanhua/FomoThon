"""各 Agent 共用的 JSON 文字產生介面。

介面與 course-agent 的 ``LLMClient`` 相同（``generate(system_prompt, user_prompt) -> str``），
所以三個 Agent 可以共用同一個模型設定，也都能在測試中換成假模型。
"""

import logging
import os
from typing import Protocol

DEFAULT_MODEL = "gpt-4.1-mini"
MODEL_ENV = "SKILL_LLM_MODEL"


class JsonClient(Protocol):
    def generate(self, system_prompt: str, user_prompt: str) -> str: ...


def resolve_model(explicit: str | None = None) -> str:
    """模型名稱的優先順序：命令列參數 > SKILL_LLM_MODEL > 預設值。"""
    return (explicit or os.environ.get(MODEL_ENV) or DEFAULT_MODEL).strip()


class OpenAIJsonClient:
    """OpenAI Chat Completions 的 JSON 模式；金鑰只從環境變數 OPENAI_API_KEY 讀取。"""

    def __init__(self, model: str | None = None, *, timeout: float = 60.0, max_retries: int = 3,
                 temperature: float | None = None):
        from openai import OpenAI  # 延後匯入：測試與離線讀取不需要安裝 SDK

        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("缺少 OPENAI_API_KEY 環境變數")
        self.model = resolve_model(model)
        # 不指定時沿用服務端預設值；分類判斷這類需要結果穩定的工作可以設為 0
        self._options = {} if temperature is None else {"temperature": temperature}
        self._client = OpenAI(max_retries=max_retries, timeout=timeout)
        # SDK 會把每個 HTTP 請求記在 INFO，批次時太吵；建立用戶端之後再設定，才不會被 SDK 的日誌設定蓋掉
        logging.getLogger("httpx").setLevel(logging.WARNING)

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self._client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            **self._options,
        )
        return response.choices[0].message.content or ""
