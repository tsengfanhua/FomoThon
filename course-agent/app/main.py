"""Skill Analysis FastAPI 應用。"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.skills import router

app = FastAPI(title="Skill Analysis API", version="0.1")
app.include_router(router)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": "請求格式或欄位無效"})
