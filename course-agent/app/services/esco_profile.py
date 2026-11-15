"""以已確認修課紀錄建立保留課程證據的 ESCO 結果。"""

from app.services.course_resolver import resolve_course
from app.services.skill_extraction import extract_esco_skills
from app.schemas.skills import Enrollment
from pydantic import ValidationError
from time import perf_counter


def analyze_esco_enrollments(enrollments, course_db, repository, client, fetcher=None, trace=None):
    """逐門處理；一筆失敗不阻止其他課程。"""
    courses, skills = [], {}
    for enrollment in enrollments:
        public_enrollment = dict(enrollment)
        public_enrollment.pop("course_id", None)
        legacy_code = public_enrollment.pop("selection_code", None)
        if "course_code" not in public_enrollment and legacy_code is not None:
            public_enrollment["course_code"] = legacy_code
        entry = {"enrollment": public_enrollment, "status": "failed", "skills_status": "not_attempted"}
        courses.append(entry)
        try:
            validated = Enrollment.model_validate(enrollment)
            if validated.academic_year is None:
                raise ValueError("缺少學年")
            normalized = validated.model_dump()
            entry["enrollment"] = normalized
            started = perf_counter()
            if trace:
                from app.services.syllabus_client import fetch_syllabus
                def traced_fetch(*args):
                    fetch_start = perf_counter()
                    try:
                        data = (fetcher or fetch_syllabus)(*args)
                    except Exception as exc:
                        known = {"website_unavailable", "unsafe_redirect", "unexpected_redirect", "too_many_redirects", "unexpected_response", "identity_mismatch", "incomplete_syllabus", "needs_confirmation"}
                        reason = getattr(exc, "reason", "website_error")
                        trace.record("website_fallback", "failed", fetch_start, "public_website", reason if reason in known else "website_error")
                        raise
                    trace.record("website_fallback", "success", fetch_start, "public_website")
                    return data
                active_fetcher = traced_fetch
            else:
                active_fetcher = fetcher
            try:
                resolution = resolve_course(course_db, normalized, fetcher=active_fetcher)
            except Exception:
                if trace: trace.record("course_resolution", "failed", started, "local_index", "resolution_error")
                raise
            if trace:
                trace.record("course_resolution", resolution["status"], started,
                             resolution.get("source", "local_index"),
                             (resolution.get("reason") or resolution["status"]) if resolution["status"] != "matched" else None)
            entry["status"] = resolution["status"]
            if resolution["status"] != "matched":
                entry["reason"] = resolution.get("reason")
                continue
            course = resolution["course"]
            entry["course_id"] = course["course_id"]
            entry["source"] = resolution.get("source", "local")
            result = extract_esco_skills(course_db, repository, course["course_id"], client, trace=trace)
            entry["skills_status"] = result["status"]
            entry["unmapped"] = result.get("unmapped", [])
            if result.get("error_reason"):
                entry["reason"] = result["error_reason"]
            for item in result["skills"]:
                skill = skills.setdefault(item["conceptUri"], {"conceptUri": item["conceptUri"],
                    "preferredLabel": item["preferredLabel"], "description": item["description"], "evidence": []})
                evidence = {"course_id": course["course_id"], "course_name": course["course_name"],
                            "source_section": item["source_section"], "evidence": item["evidence"]}
                if evidence not in skill["evidence"]:
                    skill["evidence"].append(evidence)
        except (ValidationError, ValueError):
            entry["status"] = "invalid_input"
            entry["reason"] = "invalid_enrollment"
        except Exception:
            entry["status"] = "failed"
            entry["reason"] = "processing_error"
    return {"courses": courses, "skills": list(skills.values())}
