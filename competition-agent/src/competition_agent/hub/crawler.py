"""比賽資訊爬蟲：只抓公開頁面，遵守 robots.txt、限速，並把抓回來的內容視為不可信資料。

兩種來源：
- 獎金獵人（bhuntr.com）：由年度 sitemap 取得最近更新的比賽頁，解析頁面內的 schema.org Event（JSON-LD）。
  主站 robots.txt 允許抓取；它的 api 子網域不允許，所以不呼叫 API。
- 任意官方比賽網址：抓取頁面並抽出可見文字。

安全邊界：只接受 https；連線前解析網域，拒絕本機、私有網段與保留位址（避免被用來打內部服務）；
每次轉址都重新檢查網址與該網域的 robots.txt；限制回應大小、內容類型與整體下載時間；
不接受壓縮過的回應（多層壓縮可以用幾百位元組撐爆記憶體）。不保存主辦單位的聯絡電話與 Email。

已知限制：網域檢查與實際連線是兩次 DNS 解析，惡意網域理論上可在兩次之間換成內網位址；
因為只連 https 且驗證憑證，拿不到內網服務的回應。robots.txt 以標準函式庫解析，不支援萬用字元規則。
"""

import hashlib
import html
import ipaddress
import json
import re
import socket
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx

USER_AGENT = "CampusCompetitionBot/0.1 (student research prototype; respects robots.txt)"
PAGE_MAX_BYTES = 1_500_000
SITEMAP_MAX_BYTES = 8_000_000
TIMEOUT_SECONDS = 20.0
# 單一頁面從開始到下載完成的總時間上限：TIMEOUT_SECONDS 只管每次讀取，擋不住刻意慢慢吐資料的伺服器
FETCH_DEADLINE_SECONDS = 45.0
MAX_REDIRECTS = 3
REQUEST_INTERVAL_SECONDS = 1.0
BHUNTR_HOST = "bhuntr.com"
BHUNTR_ID = re.compile(r"^https://bhuntr\.com/competitions/([a-z0-9]{6,40})$")
TEXT_TYPES = ("text/html", "application/xhtml+xml", "text/xml", "application/xml", "text/plain")
# 不略過 form：有些網站（例如 ASP.NET WebForms）把整頁內容包在 form 裡
SKIPPED_TAGS = frozenset({"script", "style", "noscript", "svg", "template", "iframe", "nav", "footer",
                          "select", "option", "button", "textarea"})
BLOCK_TAGS = frozenset({"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "section", "article", "td"})


class CrawlError(Exception):
    """帶有固定原因代碼的抓取錯誤；訊息不含網址以外的細節。"""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class RawCompetition:
    """從頁面抽出的原始比賽資料；文字欄位尚未經模型處理。"""

    competition_id: str
    source_site: str
    source_url: str
    name: str
    organizer: str | None
    start_date: str | None
    deadline: str | None
    keywords: tuple[str, ...]
    text: str
    fetched_at: str


def is_public_host(host: str) -> bool:
    """網域解析出的所有位址都必須是公開位址。"""
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return False
    addresses = {info[4][0] for info in infos}
    return bool(addresses) and all(ipaddress.ip_address(address).is_global for address in addresses)


def check_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:  # 埠號不是數字、方括號不成對等格式錯誤
        raise CrawlError("unsupported_url") from None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise CrawlError("unsupported_url")
    if port not in (None, 443):
        raise CrawlError("unsupported_url")
    if not is_public_host(parsed.hostname):
        raise CrawlError("non_public_host")
    return url


@dataclass
class Crawler:
    """單次執行共用的抓取器：記住各網域的 robots.txt，並在請求之間等待。"""

    client: httpx.Client
    interval: float = REQUEST_INTERVAL_SECONDS
    _robots: dict[str, RobotFileParser | None] = field(default_factory=dict)
    _last_request: float = 0.0

    def _get(self, url: str, max_bytes: int, check_robots: bool = False) -> tuple[str, str]:
        """手動處理轉址並逐次檢查；回傳（最終網址、文字內容）。"""
        for _ in range(MAX_REDIRECTS + 1):
            check_url(url)
            if check_robots and not self.allowed(url):  # 轉址到別的網域時，也要遵守那個網域的 robots.txt
                raise CrawlError("blocked_by_robots")
            wait = self.interval - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = started = time.monotonic()
            try:
                with self.client.stream("GET", url, follow_redirects=False, timeout=TIMEOUT_SECONDS,
                                        headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xml;q=0.9",
                                                 "Accept-Encoding": "identity"}) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        try:
                            url = urljoin(url, response.headers.get("location", ""))
                        except ValueError:
                            raise CrawlError("unsupported_url") from None
                        continue
                    if response.status_code != 200:
                        raise CrawlError(f"http_{response.status_code}")
                    if not response.headers.get("content-type", "").split(";")[0].strip().lower().startswith(TEXT_TYPES):
                        raise CrawlError("unsupported_content_type")
                    if response.headers.get("content-encoding", "identity").strip().lower() not in ("", "identity"):
                        raise CrawlError("compressed_response")
                    # 上面已拒絕有 Content-Encoding 的回應，所以這裡讀到的就是原始位元組，不會被解壓放大
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > max_bytes:
                            raise CrawlError("response_too_large")
                        if time.monotonic() - started > FETCH_DEADLINE_SECONDS:
                            raise CrawlError("too_slow")
                        chunks.append(chunk)
                    return url, _decode(b"".join(chunks), response.charset_encoding)
            except httpx.HTTPError:
                raise CrawlError("network_error") from None
        raise CrawlError("too_many_redirects")

    def _load_robots(self, origin: str) -> RobotFileParser | None:
        """沒有 robots.txt（404）代表沒有限制；其他錯誤無法判斷，回傳 None 表示一律不抓。"""
        try:
            _, body = self._get(f"{origin}/robots.txt", 200_000)
            lines = body.splitlines()
        except CrawlError as error:
            if error.reason != "http_404":
                return None
            lines = []
        parser = RobotFileParser()
        parser.parse(lines)
        return parser

    def allowed(self, url: str) -> bool:
        """依該網域的 robots.txt 判斷；取不到 robots.txt 時保守地視為不允許。"""
        parsed = urlparse(url)
        origin = f"https://{parsed.hostname}"
        if origin not in self._robots:
            self._robots[origin] = self._load_robots(origin)
        parser = self._robots[origin]
        return parser is not None and parser.can_fetch(USER_AGENT, url)

    def fetch(self, url: str, max_bytes: int = PAGE_MAX_BYTES) -> tuple[str, str]:
        return self._get(url, max_bytes, check_robots=True)


def _decode(body: bytes, charset: str | None) -> str:
    """依回應宣告的編碼解碼；編碼名稱不存在或不是文字編碼時退回 UTF-8。"""
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except (LookupError, UnicodeError, TypeError):
        return body.decode("utf-8", errors="replace")


class _VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in SKIPPED_TAGS:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIPPED_TAGS and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def visible_text(page: str) -> tuple[str, str]:
    """回傳（標題、可見文字）；略過腳本、樣式、導覽列與表單。"""
    parser = _VisibleText()
    parser.feed(page)
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    return " ".join(parser.title.split()), "\n".join(line for line in lines if line)


def _json_ld_event(page: str) -> dict | None:
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>([\s\S]*?)</script>', page, flags=re.I):
        try:
            data = json.loads(block)
        except (json.JSONDecodeError, RecursionError):
            continue
        graph = data.get("@graph", [data]) if isinstance(data, dict) else data
        for node in graph if isinstance(graph, list) else []:
            if isinstance(node, dict) and node.get("@type") == "Event" and node.get("name"):
                return node
    return None


def _date_only(value) -> str | None:
    """取出開頭的 YYYY-MM-DD；格式對但不是真實日期（例如 9999-99-99）視為沒有日期。"""
    match = re.match(r"(\d{4}-\d{2}-\d{2})", value) if isinstance(value, str) else None
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1)).isoformat()
    except ValueError:
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# 有些比賽頁沒有設定結束時間，結構化資料的 endDate 會直接填「現在」；差距在這個範圍內就不當成截止日
NOW_TOLERANCE = timedelta(minutes=15)


def _deadline(value, now: datetime | None = None) -> str | None:
    """結束時間幾乎等於抓取當下時，視為來源沒有提供截止日（未知），不然每筆都會變成「今天截止」。"""
    day = _date_only(value)
    if day is None:
        return None
    try:
        moment = datetime.fromisoformat(value.strip())
    except ValueError:
        return day
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)   # 來源以 UTC 表示、不帶時區
    return None if abs(moment - (now or datetime.now(timezone.utc))) <= NOW_TOLERANCE else day


def list_bhuntr_latest(crawler: Crawler, year: int, limit: int) -> list[str]:
    """由年度 sitemap 取出最近更新的比賽頁網址（繁中版），新的在前。"""
    _, body = crawler.fetch(f"https://{BHUNTR_HOST}/sitemap_v2_contest_{year}.xml", SITEMAP_MAX_BYTES)
    entries = []
    for block in re.findall(r"<url>([\s\S]*?)</url>", body):
        loc = re.search(r"<loc>([^<]+)</loc>", block)
        match = BHUNTR_ID.match(html.unescape(loc.group(1)).strip()) if loc else None
        if match:
            modified = re.search(r"<lastmod>([^<]+)</lastmod>", block)
            entries.append((modified.group(1) if modified else "", match.group(1)))
    entries.sort(reverse=True)
    return [f"https://{BHUNTR_HOST}/tw/competitions/{contest_id}" for _, contest_id in entries[:limit]]


def parse_bhuntr_page(url: str, page: str) -> RawCompetition:
    event = _json_ld_event(page)
    contest_id = url.rstrip("/").rsplit("/", 1)[-1]
    if event is None or not re.fullmatch(r"[a-z0-9]{6,40}", contest_id):
        raise CrawlError("no_structured_data")
    organizer = event.get("organizer") if isinstance(event.get("organizer"), dict) else {}
    keywords = [k.strip() for k in str(event.get("keywords") or "").split(",") if k.strip()]
    return RawCompetition(
        competition_id=f"bhuntr-{contest_id}", source_site="獎金獵人", source_url=url,
        name=" ".join(str(event["name"]).split())[:200], organizer=(str(organizer.get("name") or "").strip() or None),
        start_date=_date_only(event.get("startDate")), deadline=_deadline(event.get("endDate")),
        keywords=tuple(keywords[:12]), text=str(event.get("description") or "").strip(), fetched_at=_now())


def parse_generic_page(url: str, final_url: str, page: str) -> RawCompetition:
    """任意比賽頁：優先用頁面內的 Event 結構化資料，否則用標題與可見文字。"""
    title, text = visible_text(page)
    event = _json_ld_event(page) or {}
    name = " ".join(str(event.get("name") or title or urlparse(final_url).hostname).split())[:200]
    if not text.strip():
        raise CrawlError("empty_page")
    return RawCompetition(
        competition_id=f"web-{hashlib.sha256(url.encode('utf-8')).hexdigest()[:12]}",
        source_site=urlparse(final_url).hostname or "web", source_url=url, name=name, organizer=None,
        start_date=_date_only(event.get("startDate")), deadline=_date_only(event.get("endDate")),
        keywords=(), text=text, fetched_at=_now())


def fetch_competition(crawler: Crawler, url: str) -> RawCompetition:
    final_url, page = crawler.fetch(url)
    if urlparse(final_url).hostname == BHUNTR_HOST and "/competitions/" in urlparse(final_url).path:
        return parse_bhuntr_page(final_url, page)
    return parse_generic_page(url, final_url, page)
