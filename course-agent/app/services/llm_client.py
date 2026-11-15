"""可替換的文字產生介面及 OpenAI 實作。"""

import os
from pathlib import Path
from typing import Protocol

from dotenv import load_dotenv
from openai import OpenAI

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"


def load_settings() -> dict:
    """載入專案設定並僅回報存在狀態及來源，不回傳金鑰。"""
    names = ("OPENAI_API_KEY", "SKILL_LLM_MODEL")
    existing = {name: name in os.environ for name in names}
    load_dotenv(ENV_PATH, override=False)
    return {name: {"present": bool(os.environ.get(name)),
                   "source": "environment" if existing[name] else
                             ("dotenv" if os.environ.get(name) else "missing")}
            for name in names}


class LLMClient(Protocol):
    def generate(self, system_prompt: str, user_prompt: str) -> str: ...


class OpenAIClient:
    def __init__(self, model: str):
        self.model = model
        load_dotenv(ENV_PATH, override=False)
        # 由 Service 管理重試次數，避免 SDK 額外重試。
        self.client = OpenAI(max_retries=0, timeout=60.0)

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": system_prompt},
                      {"role": "user", "content": user_prompt}],
            response_format={"type": "json_object"},
        )
        return response.choices[0].message.content or ""
