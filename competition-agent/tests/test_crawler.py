"""比賽爬蟲測試：網址檢查、robots.txt、轉址、大小與內容類型限制、頁面解析。全程不對外連線。"""
import gzip

import httpx
import pytest

from competition_agent.hub import crawler
from competition_agent.hub.crawler import (CrawlError, Crawler, check_url, fetch_competition, list_bhuntr_latest,
                                  parse_bhuntr_page, parse_generic_page, visible_text)

EVENT_PAGE = """<html><head><title>測試黑客松 - 比賽</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Event","name":" 測試  黑客松 ","organizer":{"@type":"Organization","name":"測試基金會",
   "contactPoint":{"email":"someone@example.org","telephone":"0200000000"}},
  "startDate":"2026-10-01T04:00:00","endDate":"2026-12-31T23:59:00",
  "keywords":"程式, 學生競賽","description":"參賽者需以 Python 完成資料分析作品。"},
 {"@type":"WebSite","name":"平台"}]}</script></head><body><p>內文</p></body></html>"""


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """測試不做真的 DNS 查詢：example 網域視為公開，其餘依名稱判斷。"""
    monkeypatch.setattr(crawler, "is_public_host", lambda host: not host.startswith(("internal", "localhost", "127.")))


def make_crawler(handler):
    return Crawler(httpx.Client(transport=httpx.MockTransport(handler)), interval=0)


def html_response(body, content_type="text/html; charset=utf-8", status=200, headers=None):
    return httpx.Response(status, content=body.encode("utf-8"), headers={"content-type": content_type, **(headers or {})})


@pytest.mark.parametrize("url", [
    "http://example.org/contest",          # 不是 https
    "https://user:pw@example.org/",        # 夾帶帳密
    "https://example.org:8443/",           # 非標準埠
    "ftp://example.org/",
    "https:///no-host",
])
def test_check_url_rejects_unsupported_urls(url):
    with pytest.raises(CrawlError) as error:
        check_url(url)
    assert error.value.reason == "unsupported_url"


def test_check_url_rejects_non_public_hosts():
    with pytest.raises(CrawlError) as error:
        check_url("https://internal.example.org/admin")
    assert error.value.reason == "non_public_host"


def test_is_public_host_rejects_loopback_and_private_addresses(monkeypatch):
    # Arrange：還原真正的判斷，只替換 DNS 查詢結果
    monkeypatch.undo()
    answers = {"loop.test": "127.0.0.1", "lan.test": "192.168.1.10", "meta.test": "169.254.169.254", "ok.test": "93.184.216.34"}
    monkeypatch.setattr(crawler.socket, "getaddrinfo", lambda host, *a, **k: [(None, None, None, "", (answers[host], 443))])

    # Act / Assert
    assert crawler.is_public_host("ok.test") is True
    assert [crawler.is_public_host(host) for host in ("loop.test", "lan.test", "meta.test")] == [False, False, False]


def test_fetch_respects_robots_disallow():
    def handler(request):
        if request.url.path == "/robots.txt":
            return html_response("User-agent: *\nDisallow: /private/\n", "text/plain")
        return html_response("<p>ok</p>")
    bot = make_crawler(handler)

    assert bot.fetch("https://example.org/public/page")[1] == "<p>ok</p>"
    with pytest.raises(CrawlError) as error:
        bot.fetch("https://example.org/private/page")
    assert error.value.reason == "blocked_by_robots"


def test_missing_robots_means_allowed_but_robots_error_means_blocked():
    allowed = make_crawler(lambda r: html_response("", status=404) if r.url.path == "/robots.txt" else html_response("<p>ok</p>"))
    blocked = make_crawler(lambda r: html_response("", status=503) if r.url.path == "/robots.txt" else html_response("<p>ok</p>"))

    assert allowed.fetch("https://example.org/a")[1] == "<p>ok</p>"
    with pytest.raises(CrawlError) as error:
        blocked.fetch("https://example.org/a")
    assert error.value.reason == "blocked_by_robots"


def test_redirect_to_non_public_host_is_refused():
    def handler(request):
        if request.url.path == "/robots.txt":
            return html_response("", status=404)
        return httpx.Response(302, headers={"location": "https://internal.example.org/secret"})

    with pytest.raises(CrawlError) as error:
        make_crawler(handler).fetch("https://example.org/go")
    assert error.value.reason == "non_public_host"


def test_redirect_is_followed_and_final_url_reported():
    def handler(request):
        if request.url.path == "/robots.txt":
            return html_response("", status=404)
        if request.url.path == "/old":
            return httpx.Response(301, headers={"location": "/new"})
        return html_response("<p>new</p>")

    final_url, body = make_crawler(handler).fetch("https://example.org/old")

    assert (final_url, body) == ("https://example.org/new", "<p>new</p>")


@pytest.mark.parametrize(("response", "reason"), [
    (html_response("x" * 2000), "response_too_large"),
    (html_response("%PDF", "application/pdf"), "unsupported_content_type"),
    (html_response("gone", status=410), "http_410"),
])
def test_fetch_rejects_oversized_or_unexpected_responses(response, reason):
    bot = make_crawler(lambda r: html_response("", status=404) if r.url.path == "/robots.txt" else response)

    with pytest.raises(CrawlError) as error:
        bot.fetch("https://example.org/a", max_bytes=1000)
    assert error.value.reason == reason


def test_parse_bhuntr_page_reads_event_and_drops_contact_details():
    raw = parse_bhuntr_page("https://bhuntr.com/tw/competitions/abc123xyz", EVENT_PAGE)

    assert raw.competition_id == "bhuntr-abc123xyz"
    assert (raw.name, raw.organizer) == ("測試 黑客松", "測試基金會")
    assert (raw.start_date, raw.deadline) == ("2026-10-01", "2026-12-31")
    assert raw.keywords == ("程式", "學生競賽")
    assert "Python" in raw.text
    assert "someone@example.org" not in repr(raw) and "0200000000" not in repr(raw)


def test_parse_bhuntr_page_without_structured_data_fails():
    with pytest.raises(CrawlError) as error:
        parse_bhuntr_page("https://bhuntr.com/tw/competitions/abc123xyz", "<html><body>沒有結構化資料</body></html>")
    assert error.value.reason == "no_structured_data"


def test_visible_text_skips_scripts_and_navigation():
    title, text = visible_text("<html><head><title> 官方  簡章 </title><style>p{}</style></head><body>"
                               "<nav>首頁 關於</nav><script>alert('x')</script><h1>報名資格</h1><p>大專 在學學生</p></body></html>")

    assert title == "官方 簡章"
    assert text == "報名資格\n大專 在學學生"


def test_parse_generic_page_uses_title_and_stable_id():
    page = "<html><head><title>校園創新賽</title></head><body><p>每隊 2 至 4 人</p></body></html>"

    first = parse_generic_page("https://example.org/contest", "https://example.org/contest/", page)
    second = parse_generic_page("https://example.org/contest", "https://example.org/contest/", page)

    assert first.competition_id == second.competition_id and first.competition_id.startswith("web-")
    assert (first.name, first.source_site, first.deadline) == ("校園創新賽", "example.org", None)
    with pytest.raises(CrawlError):
        parse_generic_page("https://example.org/empty", "https://example.org/empty", "<html><body></body></html>")


def test_list_bhuntr_latest_sorts_by_lastmod_and_ignores_other_urls():
    sitemap = """<urlset>
      <url><loc>https://bhuntr.com/competitions/olderone1</loc><lastmod>2026-09-01</lastmod></url>
      <url><loc>https://bhuntr.com/competitions/newerone2</loc><lastmod>2026-11-10</lastmod></url>
      <url><loc>https://bhuntr.com/about</loc><lastmod>2026-11-11</lastmod></url>
      <url><loc>https://evil.example/competitions/zzzzzzzz</loc><lastmod>2026-11-12</lastmod></url></urlset>"""

    def handler(request):
        if request.url.path == "/robots.txt":
            return html_response("User-agent: *\nAllow: /\n", "text/plain")
        assert request.url.path == "/sitemap_v2_contest_2026.xml"
        return html_response(sitemap, "application/xml")

    urls = list_bhuntr_latest(make_crawler(handler), 2026, limit=5)

    assert urls == ["https://bhuntr.com/tw/competitions/newerone2", "https://bhuntr.com/tw/competitions/olderone1"]


def test_fetch_competition_picks_parser_by_host():
    def handler(request):
        if request.url.path == "/robots.txt":
            return html_response("", status=404)
        return html_response(EVENT_PAGE)
    bot = make_crawler(handler)

    from_platform = fetch_competition(bot, "https://bhuntr.com/tw/competitions/abc123xyz")
    from_official = fetch_competition(bot, "https://example.org/contest")

    assert from_platform.source_site == "獎金獵人"
    assert from_official.competition_id.startswith("web-") and from_official.deadline == "2026-12-31"


# ---- 審查後補上的回歸測試 ----

@pytest.mark.parametrize("url", ["https://example.org:99999/", "https://example.org:abc/", "https://[::1/x"])
def test_malformed_urls_are_reported_as_unsupported_not_crashes(url):
    with pytest.raises(CrawlError) as error:
        check_url(url)
    assert error.value.reason == "unsupported_url"


def test_compressed_responses_are_refused_and_identity_is_requested():
    seen = {}

    def handler(request):
        if request.url.path == "/robots.txt":
            return html_response("", status=404)
        seen["accept-encoding"] = request.headers.get("accept-encoding")
        # 真正的兩層 gzip：若照一般方式讀取，httpx 會連續解壓，小小的回應可以放大成數百 MB
        body = gzip.compress(gzip.compress(b"<p>ok</p>"))
        return httpx.Response(200, content=body, headers={"content-type": "text/html", "content-encoding": "gzip, gzip"})

    with pytest.raises(CrawlError) as error:
        make_crawler(handler).fetch("https://example.org/bomb")
    assert error.value.reason == "compressed_response"
    assert seen["accept-encoding"] == "identity"


def test_redirect_target_must_also_pass_its_own_robots():
    requested = []

    def handler(request):
        requested.append(f"{request.url.host}{request.url.path}")
        if request.url.host == "a.example.org":
            return html_response("", status=404) if request.url.path == "/robots.txt" else httpx.Response(
                302, headers={"location": "https://b.example.org/private/page"})
        return html_response("User-agent: *\nDisallow: /\n", "text/plain") if request.url.path == "/robots.txt" else html_response("<p>secret</p>")

    with pytest.raises(CrawlError) as error:
        make_crawler(handler).fetch("https://a.example.org/go")
    assert error.value.reason == "blocked_by_robots"
    assert "b.example.org/private/page" not in requested


def test_malformed_redirect_and_unknown_charset_do_not_crash():
    def bad_redirect(request):
        return html_response("", status=404) if request.url.path == "/robots.txt" else httpx.Response(302, headers={"location": "https://x:99999/"})

    def odd_charset(request):
        return html_response("", status=404) if request.url.path == "/robots.txt" else html_response("<p>內文</p>", "text/html; charset=base64")

    with pytest.raises(CrawlError) as error:
        make_crawler(bad_redirect).fetch("https://example.org/go")
    assert error.value.reason == "unsupported_url"
    assert make_crawler(odd_charset).fetch("https://example.org/a")[1] == "<p>內文</p>"


def test_invalid_calendar_dates_and_deep_json_are_ignored():
    page = EVENT_PAGE.replace("2026-12-31T23:59:00", "9999-99-99T00:00:00")
    deep = '<script type="application/ld+json">' + "[" * 100000 + "]" * 100000 + "</script><p>內文夠長的頁面</p>"

    assert parse_bhuntr_page("https://bhuntr.com/tw/competitions/abc123xyz", page).deadline is None
    assert parse_generic_page("https://example.org/c", "https://example.org/c", deep).deadline is None


def test_pages_wrapped_in_a_form_still_yield_text():
    _, text = visible_text("<html><body><form id='aspnetForm'><h1>競賽辦法</h1><p>每隊三人</p>"
                           "<select><option>不該出現</option></select><button>送出</button></form></body></html>")

    assert text == "競賽辦法\n每隊三人"


def test_collect_survives_unexpected_errors_and_reports_reasons(monkeypatch):
    from scripts import crawl_competitions as cli

    pages = {"https://example.org/boom": RuntimeError("unexpected"), "https://example.org/robots": CrawlError("blocked_by_robots"),
             "https://example.org/old": "old", "https://example.org/run": "run", "https://example.org/ok": "ok"}

    def fake_fetch(_crawler, url):
        outcome = pages[url]
        if isinstance(outcome, Exception):
            raise outcome
        names = {"old": "已截止的比賽", "run": "城市馬拉松", "ok": "校園創新賽"}
        return crawler.RawCompetition(f"web-{outcome}", "t", url, names[outcome], None, None,
                                      "2026-01-01" if outcome == "old" else "2027-01-01", (), "內文", "2026-11-13T00:00:00+00:00")

    monkeypatch.setattr(cli, "fetch_competition", fake_fetch)

    found, stats = cli.collect(None, list(pages), wanted=5, today="2026-11-13", skip=set())

    assert [raw.competition_id for raw in found] == ["web-ok"]
    assert (stats["fetch_failed"], stats["skipped_closed"], stats["skipped_scope"]) == (2, 1, 1)
    assert stats["reasons"] == ["unexpected_error", "blocked_by_robots", "closed", "out_of_scope"]


def test_exported_items_are_accepted_by_the_source_import_adapter(tmp_path):
    # Arrange：爬到的比賽存成來源匯入格式
    from competition_agent.adapters.crawler_json import import_category_json, source_from_item
    from competition_agent.db.connection import connect, initialize
    from competition_agent.db.repository import CompetitionRepository
    from scripts import crawl_competitions as cli

    raw = parse_bhuntr_page("https://bhuntr.com/tw/competitions/abc123xyz", EVENT_PAGE)
    payload = cli.export_items([raw])
    path = tmp_path / "crawled.json"
    path.write_text(__import__("json").dumps(payload, ensure_ascii=False), encoding="utf-8")

    # Act：用本套件原有的轉接器匯入
    connection = connect(str(tmp_path / "competition.sqlite3"))
    try:
        initialize(connection)
        report = import_category_json(path, CompetitionRepository(connection))
        again = import_category_json(path, CompetitionRepository(connection))
        stored = connection.execute("SELECT source_url, source_school, title, published_at FROM competition_sources").fetchall()
    finally:
        connection.close()

    # Assert：欄位齊全、可重複匯入不重複
    assert source_from_item(payload["items"][0])["clean_content"] == raw.text
    assert (report.inserted, report.duplicates, report.rejected) == (1, 0, [])
    assert (again.inserted, again.duplicates) == (0, 1)
    assert [tuple(row) for row in stored] == [("https://bhuntr.com/tw/competitions/abc123xyz", "獎金獵人", "測試 黑客松", "2026-10-01")]


def test_end_date_equal_to_fetch_time_is_not_a_deadline():
    # 來源頁沒有設定結束時間時，endDate 會填「現在」；不能當成今天截止
    from datetime import datetime, timezone

    now = datetime(2026, 11, 13, 0, 7, 46, tzinfo=timezone.utc)

    assert crawler._deadline("2026-11-13T00:07:46", now) is None
    assert crawler._deadline("2026-11-13T00:01:00", now) is None            # 幾分鐘內的誤差
    assert crawler._deadline("2026-11-13T10:00:00", now) == "2026-11-13"    # 同一天但真的是截止時間
    assert crawler._deadline("2026-12-24T16:00:00", now) == "2026-12-24"
    assert crawler._deadline("9999-99-99T00:00:00", now) is None
    assert crawler._deadline(None, now) is None
