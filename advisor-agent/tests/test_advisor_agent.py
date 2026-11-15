from fastapi.testclient import TestClient
from app.agents.advisor_agent import recommend_advisors
from app.schemas.advisors import AdvisorMatchRequest, AdvisorProfile


def test_advisor_match_ranks_relevant_profile():
    request = AdvisorMatchRequest.model_validate({
        "competition": {"competition_id": "C1", "competition_name": "AI 創新應用競賽",
                        "topic": "人工智慧", "required_skills": ["機器學習"],
                        "related_courses": ["機器學習"]},
        "student": {"completed_courses": ["機器學習"]}
    })
    profiles = [
        AdvisorProfile(teacher_id="T1", teacher_name="甲", expertise=["人工智慧", "機器學習"],
                       research_areas=[], courses=["機器學習"], advised_competitions=["AI 創新應用競賽"]),
        AdvisorProfile(teacher_id="T2", teacher_name="乙", expertise=["資訊安全"],
                       research_areas=[], courses=["密碼學"], advised_competitions=[]),
    ]
    result = recommend_advisors(request, profiles)
    assert result.advisors[0].teacher_id == "T1"
    assert result.advisors[0].match_score is not None
    assert result.advisors[0].score_coverage == 100.0
    assert set(result.advisors[0].dimensions) == {"expertise_match", "course_match", "competition_experience"}


def test_student_course_relation_and_capacity_are_not_scored():
    request = AdvisorMatchRequest.model_validate({
        "competition": {"competition_id": "C1", "competition_name": "AI 競賽",
                        "topic": "AI", "required_skills": []},
        "student": {"completed_courses": ["Python"]}
    })
    profile = AdvisorProfile(teacher_id="T1", teacher_name="甲", expertise=["AI"],
                             research_areas=[], courses=[], advised_competitions=[], availability="unknown")
    result = recommend_advisors(request, [profile]).advisors[0]
    assert set(result.dimensions) == {"expertise_match", "course_match", "competition_experience"}
    assert result.dimensions["expertise_match"].weight == 0.5
    assert result.dimensions["course_match"].weight == 0.25
    assert result.dimensions["competition_experience"].weight == 0.25


def test_advisor_api_list_and_match():
    from fastapi import FastAPI
    from app.api.advisors import router
    test_app = FastAPI()
    test_app.include_router(router)
    client = TestClient(test_app)
    response = client.get("/api/v1/advisors")
    assert response.status_code == 200
    assert response.json()["count"] == 630
    matched = client.post("/api/v1/advisors/match", json={
        "competition": {"competition_id": "C1", "competition_name": "AI 創新應用競賽",
                        "topic": "人工智慧", "required_skills": ["機器學習"],
                        "related_courses": ["機器學習"]},
        "student": {"completed_courses": ["Python 程式設計"]}, "top_k": 2
    })
    assert matched.status_code == 200
    assert len(matched.json()["advisors"]) == 2
