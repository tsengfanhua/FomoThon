"""人工複核工具的測試：抽樣、複核表、指標與報告。不呼叫外部服務。"""

import json
import sqlite3
from contextlib import closing
from math import sqrt

import pytest
from openpyxl import load_workbook

from shared.audit import metrics
from shared.audit.build import KEY_FILE, build_audit
from shared.audit.report import build_report
from shared.audit.sampling import load_links, load_pairs, sample_links, sample_pairs
from shared.audit.workbook import LINK_SHEET, PAIR_SHEET, read_labels
from shared.esco.init_db import initialize_esco
from shared.esco.pair_judge import pair_key
from shared.esco.similarity import update_similarity
from shared.hub import db as hub_db

BASE = "http://data.europa.eu/esco/skill/"
ML, UML, DL, ETH = (BASE + name for name in ("ml", "use-ml", "deep-learning", "data-ethics"))
LABELS = {ML: "machine learning", UML: "utilise machine learning", DL: "deep learning", ETH: "data ethics"}
TEACHER, COLLEAGUE = "王小明", "李大華"
ADJUDICATION = "audit_adjudication.xlsx"


def unit(cosine: float) -> list[float]:
    return [cosine, sqrt(1 - cosine * cosine)]


class FakeEmbedder:
    model = "text-embedding-3-small"
    vectors = {"machine learning": unit(1.0), "utilise machine learning": unit(0.62),
               "deep learning": unit(0.90), "data ethics": unit(0.65)}

    def embed(self, texts):
        return [self.vectors[text.split(":")[0]] for text in texts]


class FakeJudge:
    model = "fake-judge"
    relations = {frozenset({"machine learning", "utilise machine learning"}): "same",
                 frozenset({"machine learning", "deep learning"}): "related_distinct",
                 frozenset({"machine learning", "data ethics"}): "unrelated"}

    def generate(self, system_prompt, user_prompt):
        return json.dumps({"items": [
            {"id": pair["id"], "relation": self.relations[frozenset({pair["a"]["label"], pair["b"]["label"]})],
             "reason": "測試"} for pair in json.loads(user_prompt)]})


class BrokenJudge:
    model = "fake-judge"

    def generate(self, system_prompt, user_prompt):
        raise RuntimeError("boom")


def skill(uri: str, text: str) -> dict:
    return {"conceptUri": uri, "source_section": "s", "evidence": text}


@pytest.fixture
def dbs(tmp_path):
    """三個資料庫：比賽需要 machine learning；兩位教師、三門課各有對應；相近配對已用模型判斷算過。"""
    csv_path = tmp_path / "skills.csv"
    rows = "".join(f"{uri},{label},Description of {label}.\n" for uri, label in LABELS.items())
    csv_path.write_text("conceptUri,preferredLabel,description\n" + rows, encoding="utf-8")
    esco = tmp_path / "esco.sqlite"
    initialize_esco(csv_path, esco)
    with closing(sqlite3.connect(esco)) as conn, conn:
        conn.execute("CREATE TABLE esco_labels_zh (concept_uri TEXT PRIMARY KEY, label_zh TEXT NOT NULL, model TEXT)")
        conn.execute("INSERT INTO esco_labels_zh VALUES (?, '機器學習', 'm')", (ML,))

    hub = tmp_path / "hub.sqlite"
    hub_db.initialize(hub)
    hub_db.save_competition(hub, {"competition_id": "C1", "name": "測試盃", "category": "資訊", "summary": "AI 競賽",
                                  "source_site": "t", "source_url": "https://example.org", "status": "mapped",
                                  "fetched_at": hub_db.now_iso()}, [skill(ML, "需具備機器學習能力")])
    hub_db.save_advisor(hub, {"teacher_id": "T1", "name": TEACHER, "department": "資工系", "status": "mapped",
                              "expertise": ["深度學習"]},
                        [skill(DL, f"{TEACHER}主持深度學習計畫"), skill(ETH, f"與{COLLEAGUE}合著資料倫理專書")])
    hub_db.save_advisor(hub, {"teacher_id": "T2", "name": COLLEAGUE, "status": "unmapped"}, [])

    course = tmp_path / "course.sqlite"
    with closing(sqlite3.connect(course)) as conn, conn:
        conn.execute("CREATE TABLE courses (course_id TEXT PRIMARY KEY, course_name TEXT NOT NULL, description TEXT)")
        conn.execute("CREATE TABLE course_skills (course_id TEXT, concept_uri TEXT, source_section TEXT, evidence TEXT)")
        for index in range(1, 4):
            conn.execute("INSERT INTO courses VALUES (?, ?, ?)", (f"K{index}", f"課程{index}", f"由{TEACHER}老師授課"))
            conn.execute("INSERT INTO course_skills VALUES (?, ?, 'description', ?)",
                         (f"K{index}", UML, f"{COLLEAGUE}老師帶領運用機器學習{index}"))

    update_similarity(esco, hub, course, FakeEmbedder(), FakeJudge())
    return {"esco_db": esco, "hub_db": hub, "course_db": course}


@pytest.fixture
def audit(dbs, tmp_path):
    """已經抽好樣的複核資料夾，以及配對的編號對照。"""
    out_dir = tmp_path / "audit"
    build_audit(**dbs, out_dir=out_dir, per_source=2, pair_limit=0, seed=42)
    key = json.loads((out_dir / KEY_FILE).read_text(encoding="utf-8"))
    pair_id = {pair_key(info["a"], info["b"]): sample_id for sample_id, info in key["pairs"].items()}
    return out_dir, pair_id


def fill(path, sheet: str, labels: dict[str, str], notes: dict[str, str] | None = None) -> None:
    """模擬標註者：依編號把判定（與備註）填進表裡。"""
    workbook = load_workbook(path)
    worksheet = workbook[sheet]
    header = [cell.value for cell in worksheet[1]]
    verdict, note = header.index("判定") + 1, header.index("備註") + 1
    for row in worksheet.iter_rows(min_row=2):
        if row[0].value in labels:
            worksheet.cell(row=row[0].row, column=verdict, value=labels[row[0].value])
        if notes and row[0].value in notes:
            worksheet.cell(row=row[0].row, column=note, value=notes[row[0].value])
    workbook.save(path)


def all_text(path) -> str:
    workbook = load_workbook(path)
    return " ".join(str(cell.value) for worksheet in workbook for row in worksheet.iter_rows() for cell in row)


def test_wilson_interval_matches_a_published_example():
    # 189/200 的 Wilson 95% 信賴區間是 90.4%–96.9%（Tang 等人 2026 的職務複核數字）
    low, high = metrics.wilson(189, 200)

    assert round(low, 3) == 0.904 and round(high, 3) == 0.969
    assert metrics.wilson(0, 0) is None
    with pytest.raises(ValueError):
        metrics.wilson(11, 10)


def test_cohen_kappa_corrects_for_chance_agreement():
    assert metrics.cohen_kappa(["y", "y", "n", "n"], ["y", "n", "n", "n"]) == pytest.approx(0.5)
    assert metrics.cohen_kappa(["y", "y"], ["y", "y"]) is None  # 只有一種標記，無法計算
    assert metrics.cohen_kappa([], []) is None


def test_link_precision_reports_strict_and_lenient():
    result = metrics.link_precision(["正確", "正確", "粒度不符", "錯誤"])

    assert result["strict"]["k"] == 2 and result["strict"]["p"] == 0.5
    assert result["lenient"]["k"] == 3 and result["lenient"]["p"] == 0.75


def test_precision_bounds_span_the_undecided_items():
    # 76 筆正確、4 筆錯誤、另有 20 筆還沒定論：精確率可能從 76% 到 96%
    assert metrics.precision_bounds(76, 80, 20) == (0.76, 0.96)
    assert metrics.precision_bounds(0, 0, 0) is None


def test_weighted_precision_needs_every_source():
    # Arrange：課程母體最大但精確率最低
    done = {"strict": metrics.proportion(1, 2)}
    by_source = {"course": done, "advisor": {"strict": metrics.proportion(2, 2)}, "competition": {"strict": metrics.proportion(2, 2)}}
    population = {"course": 800, "advisor": 100, "competition": 100, "pairs": 5}

    # Act / Assert：依母體加權；缺一個來源就不給整體數字
    assert metrics.weighted_precision(by_source, population) == 0.6
    missing = {**by_source, "course": {"strict": metrics.proportion(0, 0)}}
    assert metrics.weighted_precision(missing, population) is None


def test_variant_scores_compare_a_method_against_human_labels():
    truth = {"a": True, "b": True, "c": False, "d": False}
    predicted = {"a": True, "b": False, "c": True, "d": False}

    scores = metrics.variant_scores(truth, predicted)

    assert scores["precision"]["p"] == 0.5 and scores["recall"]["p"] == 0.5 and scores["f1"] == 0.5


def test_paired_comparison_counts_only_the_pairs_the_methods_disagree_on():
    truth = {"a": True, "b": True, "c": False, "d": False, "e": True}
    first = {"a": True, "b": False, "c": False, "d": True, "e": False}    # 對 a、c
    second = {"a": True, "b": True, "c": False, "d": False, "e": True}    # 全對

    result = metrics.paired_comparison(truth, first, second)

    assert (result["first_only"], result["second_only"]) == (0, 3)
    assert result["p_value"] == 0.25 and metrics.mcnemar_exact(0, 0) is None


def test_sample_links_is_reproducible_and_hides_every_teacher_name(dbs):
    # Arrange
    population = load_links(**dbs)

    # Act
    first = sample_links(population, per_source=2, seed=42)
    again = sample_links(population, per_source=2, seed=42)

    # Assert：同一個種子抽到同一批；每個來源最多 2 筆（比賽只有 1 筆）
    assert first == again
    assert [item.source for item in first] == ["course", "course", "advisor", "advisor", "competition"]
    assert {item.sample_id for item in first} == {"CRS-001", "CRS-002", "ADV-001", "ADV-002", "CMP-001"}
    # 本人、同事、課綱裡提到的老師，姓名都不出現
    text = " ".join(item.subject + item.evidence + item.context for item in first)
    assert TEACHER not in text and COLLEAGUE not in text
    evidence = {item.evidence for item in first}
    assert "（本人）主持深度學習計畫" in evidence and "與（教師）合著資料倫理專書" in evidence
    assert any(item.context == "由（教師）老師授課" for item in first if item.source == "course")
    assert next(item for item in first if item.source == "competition").skill_zh == "機器學習"


def test_each_source_is_sampled_independently(dbs):
    # Arrange：課程少了一筆之後重抽
    population = load_links(**dbs)
    fewer_courses = {**population, "course": population["course"][:-1]}

    # Act
    before = sample_links(population, per_source=1, seed=42)
    after = sample_links(fewer_courses, per_source=1, seed=42)

    # Assert：教師與比賽抽到的樣本不受影響
    others = lambda items: [item for item in items if item.source != "course"]  # noqa: E731
    assert others(before) == others(after)


def test_load_pairs_marks_which_method_accepts_each_candidate(dbs):
    pairs = {pair_key(pair["a_uri"], pair["b_uri"]): pair for pair in load_pairs(**dbs)}

    # 相似度 0.90 的只有門檻採用；0.62 的只有模型採用；0.65 的兩者都不採用
    assert (pairs[pair_key(ML, DL)]["by_threshold"], pairs[pair_key(ML, DL)]["by_judge"]) == (True, False)
    assert (pairs[pair_key(ML, UML)]["by_threshold"], pairs[pair_key(ML, UML)]["by_judge"]) == (False, True)
    assert (pairs[pair_key(ML, ETH)]["by_threshold"], pairs[pair_key(ML, ETH)]["by_judge"]) == (False, False)
    assert pairs[pair_key(ML, UML)]["relation"] == "same"
    assert len(sample_pairs(list(pairs.values()), limit=2, seed=42)) == 2


def test_load_pairs_follows_what_the_system_actually_adopted(dbs, monkeypatch):
    # Arrange：準則改版後模型全部判斷不了，系統退回只看門檻；資料庫裡還留著舊準則的判斷
    monkeypatch.setattr("shared.esco.pair_judge.RUBRIC_VERSION", "next")
    monkeypatch.setattr("shared.esco.similarity.RUBRIC_VERSION", "next")
    update_similarity(dbs["esco_db"], dbs["hub_db"], dbs["course_db"], FakeEmbedder(), BrokenJudge())

    # Act
    pairs = {pair_key(pair["a_uri"], pair["b_uri"]): pair for pair in load_pairs(**dbs)}

    # Assert：標記跟著實際採用的結果走，不是跟著舊的判斷紀錄
    assert pairs[pair_key(ML, UML)]["by_judge"] is False and pairs[pair_key(ML, UML)]["relation"] is None
    assert pairs[pair_key(ML, DL)]["by_judge"] is True


def test_load_pairs_has_no_judge_result_after_a_threshold_only_run(dbs):
    update_similarity(dbs["esco_db"], dbs["hub_db"], dbs["course_db"], FakeEmbedder())

    assert {pair["by_judge"] for pair in load_pairs(**dbs)} == {None}


def test_build_audit_writes_two_blind_workbooks_without_names(dbs, tmp_path):
    out_dir = tmp_path / "audit"

    summary = build_audit(**dbs, out_dir=out_dir, per_source=2, pair_limit=0, seed=42)

    assert summary["links"] == 5 and summary["pairs"] == 3
    labels = read_labels(out_dir / "audit_A.xlsx")
    assert len(labels["links"]) == 5 and len(labels["pairs"]) == 3 and set(labels["links"].values()) == {None}
    assert labels["batch"] == summary["batch"] == read_labels(out_dir / "audit_B.xlsx")["batch"]
    # 複核表不透露相似度、模型的判斷，也沒有任何教師姓名
    text = all_text(out_dir / "audit_A.xlsx")
    assert all(leak not in text for leak in ("0.62", "related_distinct", "fake-judge", TEACHER, COLLEAGUE, "資工系"))
    assert all_text(out_dir / "audit_A.xlsx").replace(summary["batch"], "") == all_text(out_dir / "audit_B.xlsx").replace(summary["batch"], "")
    key_text = (out_dir / KEY_FILE).read_text(encoding="utf-8")
    assert TEACHER not in key_text and COLLEAGUE not in key_text
    key = json.loads(key_text)
    assert key["population"] == {"course": 3, "advisor": 2, "competition": 1, "pairs": 3}
    assert key["settings"]["similarity_run"]["judge_model"] == "fake-judge"
    with pytest.raises(FileExistsError):
        build_audit(**dbs, out_dir=out_dir, per_source=2, pair_limit=0, seed=42)


def test_build_audit_stops_when_a_name_would_leak(dbs, tmp_path, monkeypatch):
    # 遮蔽萬一失效：寫表前的檢查要擋下來，而且不留下任何檔案
    monkeypatch.setattr("shared.audit.sampling._mask", lambda text, pattern, own=None: " ".join((text or "").split()))
    out_dir = tmp_path / "audit"

    with pytest.raises(ValueError):
        build_audit(**dbs, out_dir=out_dir, per_source=2, pair_limit=0, seed=42)

    assert not out_dir.exists() or not any(out_dir.iterdir())


def test_text_from_outside_is_never_written_as_a_formula(dbs, tmp_path):
    # Arrange：比賽簡章的證據以等號開頭，還夾著 Excel 不接受的控制字元
    hub_db.save_competition(dbs["hub_db"], {"competition_id": "C1", "name": "測試盃", "source_site": "t",
                                            "source_url": "https://example.org", "status": "mapped",
                                            "fetched_at": hub_db.now_iso()}, [skill(ML, "=1+1\x07 機器學習")])
    out_dir = tmp_path / "audit"

    # Act
    build_audit(**dbs, out_dir=out_dir, per_source=2, pair_limit=0, seed=42)

    # Assert
    worksheet = load_workbook(out_dir / "audit_A.xlsx")[LINK_SHEET]
    cell = next(cell for row in worksheet.iter_rows() for cell in row if str(cell.value).startswith("=1+1"))
    assert cell.data_type == "s" and cell.value == "=1+1 機器學習"


def test_report_uses_agreed_labels_and_asks_for_adjudication_on_the_rest(audit):
    # Arrange：兩位標註者對 5 筆對應中的 4 筆意見相同
    out_dir, pair_id = audit
    links_a = {"CRS-001": "正確", "CRS-002": "正確", "ADV-001": "錯誤", "ADV-002": "正確", "CMP-001": "正確"}
    links_b = {**links_a, "CRS-002": "粒度不符"}
    pairs = {pair_id[pair_key(ML, UML)]: "相同", pair_id[pair_key(ML, DL)]: "上下位", pair_id[pair_key(ML, ETH)]: "無關"}
    for name, links in (("audit_A.xlsx", links_a), ("audit_B.xlsx", links_b)):
        fill(out_dir / name, LINK_SHEET, links)
        fill(out_dir / name, PAIR_SHEET, pairs)

    # Act
    report = build_report(out_dir)

    # Assert：意見不同的那一筆先不計入，並產生待裁決的表；結果標為暫時
    links = report["links"]
    assert links["agreement"]["both"] == 5 and links["agreement"]["agree"] == 4
    assert (links["sampled"], links["settled"], links["pending"], links["unfilled"]) == (5, 4, 1, 0)
    assert report["provisional"] is True and (out_dir / ADJUDICATION).exists()
    assert links["by_source"]["course"]["strict"]["n"] == 1 and links["by_source"]["course"]["bounds"] == (0.5, 1.0)
    assert links["by_source"]["advisor"]["strict"] | {"low": 0, "high": 0} == {"n": 2, "k": 1, "p": 0.5, "low": 0, "high": 0}
    # 相近配對：人工認為 ML–UML、ML–DL 相近；門檻只抓到 ML–DL，模型只抓到 ML–UML
    variants = report["pairs"]["variants"]
    assert variants["threshold"]["recall"]["p"] == 0.5 and variants["judge"]["precision"]["p"] == 1.0
    assert variants["threshold"]["recall"]["n"] == variants["judge"]["recall"]["n"] == 2
    assert report["pairs"]["agreement_binary"]["agree"] == 3
    # 報告只有彙總數字，不含教師姓名或任何對象的代號
    text = (out_dir / "REPORT.md").read_text(encoding="utf-8")
    assert "Cohen's κ" in text and "暫時結果" in text
    assert all(leak not in text for leak in (TEACHER, COLLEAGUE, "T1", "K1"))


def test_report_counts_adjudicated_labels_and_keeps_notes_across_runs(audit):
    # Arrange：兩筆意見不同；裁決表一筆填了合格的判定與備註，另一筆填了選項以外的字
    out_dir, _ = audit
    fill(out_dir / "audit_A.xlsx", LINK_SHEET, {"CRS-001": "正確", "CRS-002": "正確"})
    fill(out_dir / "audit_B.xlsx", LINK_SHEET, {"CRS-001": "錯誤", "CRS-002": "錯誤"})
    build_report(out_dir)
    fill(out_dir / ADJUDICATION, LINK_SHEET, {"CRS-001": "粒度不符", "CRS-002": "粒度不符？"},
         {"CRS-001": "技能比原文寬", "CRS-002": "待確認"})

    # Act：之後又多出一筆意見不同的，裁決表必須重寫
    fill(out_dir / "audit_A.xlsx", LINK_SHEET, {"ADV-001": "正確"})
    fill(out_dir / "audit_B.xlsx", LINK_SHEET, {"ADV-001": "錯誤"})
    report = build_report(out_dir)

    # Assert：合格的裁決計入；先前填的判定與備註都還在，不合格的值被點名
    assert report["links"]["by_source"]["course"]["lenient"]["k"] == 1
    assert report["links"]["by_source"]["course"]["strict"]["k"] == 0 and report["links"]["pending"] == 2
    kept = read_labels(out_dir / ADJUDICATION)
    assert set(kept["links"]) == {"CRS-001", "CRS-002", "ADV-001"}
    assert kept["raw"] == {"CRS-001": "粒度不符", "CRS-002": "粒度不符？"}
    assert kept["notes"] == {"CRS-001": "技能比原文寬", "CRS-002": "待確認"}
    assert {"file": ADJUDICATION, "id": "CRS-002", "value": "粒度不符？"} in report["invalid"]


def test_report_refuses_workbooks_from_another_sample(dbs, audit):
    # Arrange：標註者填的是上一次抽樣的表，對照檔卻已經重抽
    out_dir, _ = audit
    old = (out_dir / "audit_A.xlsx").read_bytes()
    summary = build_audit(**dbs, out_dir=out_dir, per_source=1, pair_limit=0, seed=7, force=True)
    (out_dir / "audit_A.xlsx").write_bytes(old)

    # Act / Assert
    with pytest.raises(ValueError, match="批次代碼"):
        build_report(out_dir)
    assert summary["backup"] and (out_dir / "audit_B.xlsx").exists()


def test_resampling_sets_the_old_files_aside_instead_of_reusing_them(dbs, audit):
    # Arrange：舊樣本已經有裁決結果
    out_dir, _ = audit
    fill(out_dir / "audit_A.xlsx", LINK_SHEET, {"ADV-001": "正確"})
    fill(out_dir / "audit_B.xlsx", LINK_SHEET, {"ADV-001": "錯誤"})
    build_report(out_dir)
    fill(out_dir / ADJUDICATION, LINK_SHEET, {"ADV-001": "正確"})

    # Act：重抽
    summary = build_audit(**dbs, out_dir=out_dir, per_source=2, pair_limit=0, seed=7, force=True)

    # Assert：舊的表、裁決與報告都搬進備份；新的一批沒有殘留的裁決
    backup = next(out_dir.glob("backup-*"))
    assert str(backup) == summary["backup"]
    assert {path.name for path in backup.iterdir()} >= {"audit_A.xlsx", "audit_B.xlsx", ADJUDICATION, "REPORT.md", "key"}
    assert read_labels(backup / ADJUDICATION)["links"]["ADV-001"] == "正確"
    assert not (out_dir / ADJUDICATION).exists() and not (out_dir / "REPORT.md").exists()


def test_report_works_with_one_annotator_whichever_workbook_is_filled(audit):
    # 只有第二份表有填：照樣以一位複核者計算，並標為暫時結果
    out_dir, _ = audit
    fill(out_dir / "audit_B.xlsx", LINK_SHEET, {"CRS-001": "正確", "CMP-001": "錯誤"})

    report = build_report(out_dir)

    assert report["annotators"] == 1 and report["provisional"] is True
    assert report["links"]["by_source"]["course"]["strict"]["k"] == 1
    assert report["links"]["by_source"]["competition"]["strict"] | {"low": 0, "high": 0} == {
        "n": 1, "k": 0, "p": 0.0, "low": 0, "high": 0}
    assert report["links"]["weighted"]["strict"] is None and report["links"]["agreement"] is None
    assert not (out_dir / ADJUDICATION).exists()


def test_report_before_anyone_has_filled_anything(audit):
    out_dir, _ = audit

    report = build_report(out_dir)

    assert report["annotators"] == 0 and report["links"]["settled"] == 0 and report["links"]["unfilled"] == 5


def test_read_labels_reports_values_outside_the_choices(audit):
    out_dir, _ = audit
    fill(out_dir / "audit_A.xlsx", LINK_SHEET, {"CRS-001": "大概對"})

    labels = read_labels(out_dir / "audit_A.xlsx")

    assert labels["links"]["CRS-001"] is None and labels["invalid"] == [("CRS-001", "大概對")]
