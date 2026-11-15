"""公開課綱的有限次查詢。"""

from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, parse_qs

import requests

from app.services.skill_extraction import _plain_text


class SyllabusError(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class _Redirect(HTMLParser):
    def __init__(self):
        super().__init__()
        self.url = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag.lower() == "meta" and attrs.get("http-equiv", "").lower() == "refresh":
            content = attrs.get("content", "")
            if "url=" in content.lower():
                self.url = content[content.lower().index("url=") + 4:].strip(" '\"")


def _safe_url(url):
    p = urlparse(url)
    return p.scheme == "https" and (p.hostname or "").endswith(".fcu.edu.tw") and p.username is None


def fetch_syllabus(year, semester, code, name, session=None, timeout=10):
    """取得及核對課綱；不保存任何含 token 的網址。"""
    if not isinstance(code, str) or not code.isascii() or not code.isdigit() or not name:
        raise SyllabusError("needs_confirmation")
    if not str(year).isdigit() or not str(semester).isdigit():
        raise SyllabusError("needs_confirmation")
    session = session or requests.Session()

    def request(method, url, **kwargs):
        for _ in range(4):
            if not _safe_url(url):
                raise SyllabusError("unsafe_redirect")
            for attempt in range(2):
                try:
                    response = session.request(method, url, timeout=timeout, allow_redirects=False,
                                               headers={"User-Agent": "Mozilla/5.0"}, **kwargs)
                    if response.status_code not in (502, 503, 504) or attempt == 1:
                        break
                except (requests.Timeout, requests.ConnectionError):
                    if attempt == 1:
                        raise
            if response.status_code in (301, 302, 303, 307, 308):
                url = urljoin(url, response.headers.get("Location", ""))
                if method == "POST":
                    raise SyllabusError("unexpected_redirect")
                continue
            response.raise_for_status()
            return response, url
        raise SyllabusError("too_many_redirects")

    try:
        # 入口先提供伺服器與短期憑證；此憑證只在本次請求中使用。
        home, home_url = request("GET", "https://coursesearch.fcu.edu.tw/")
        parser = _Redirect()
        parser.feed(home.text)
        if not parser.url:
            raise SyllabusError("unexpected_response")
        host_url = urljoin(home_url, parser.url)
        if not _safe_url(host_url):
            raise SyllabusError("unsafe_redirect")
        outline = urljoin(host_url, f"/CourseOutline.aspx?lang=cht&courseid={year}{semester}{code}")
        source = outline
        page, page_url = request("GET", outline)
        token = parse_qs(urlparse(page_url).query).get("token", [None])[0]
        if not token:
            raise SyllabusError("unexpected_response")
        api = urljoin(page_url, "W320104_syllabus.aspx/GetCourseDetail")
        result, _ = request("POST", api, json={"access_token": token})
        data = result.json()
        if isinstance(data.get("d"), str):
            import json
            data = json.loads(data["d"])
        elif isinstance(data.get("d"), dict):
            data = data["d"]
        info = data.get("info") or {}
        identity = {k: info.get(k) for k in ("yms_year", "yms_smester", "scr_selcode", "sub_name", "sub_id", "cls_id", "scr_dup")}
        if (not data.get("success") or str(info.get("yms_year")) not in (str(year), str(year) + ".0")
                or str(info.get("yms_smester")) not in (str(semester), str(semester) + ".0")
                or info.get("scr_selcode") != code or (info.get("sub_name") or "").strip() != name.strip()
                or not all(info.get(k) for k in ("sub_id", "cls_id", "scr_dup"))):
            raise SyllabusError("identity_mismatch")
        description = _plain_text((data.get("description") or {}).get("describe_ch"))
        targets = [_plain_text(x.get("describe_ch")) for x in (data.get("targets") or [])]
        weeks = [{k: _plain_text(x.get(k)) for k in ("tpd_reading", "tpd_learn")} for x in (data.get("weeklyScds") or [])]
        if not description or not any(targets) or not any(any(w.values()) for w in weeks):
            raise SyllabusError("incomplete_syllabus")
        return {"year": int(year), "semester": int(semester), "course_code": code,
                "course_name": name.strip(), "description": description, "targets": targets,
                "weekly_schedule": weeks, "source_url": source, "identity": identity,
                "fetched_at": datetime.now(timezone.utc).isoformat()}
    except SyllabusError:
        raise
    except (requests.RequestException, ValueError, TypeError, KeyError, AttributeError):
        raise SyllabusError("website_unavailable") from None
