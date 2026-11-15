"""Skill Analysis FastAPI 應用。"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.skills import router
from app.api.advisors import router as advisors_router

app = FastAPI(title="FomoThon Agent API", version="0.2")
app.include_router(router)
app.include_router(advisors_router)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": "請求格式或欄位無效"})
