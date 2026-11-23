#!/usr/bin/env python3
"""Local review board. stdlib server, Excel matrix import and iWencai enrichment."""
from __future__ import annotations
import argparse
import base64
import copy
import datetime as dt
import getpass
import io
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import shutil
import subprocess
import threading
import unicodedata
import urllib.error
import urllib.request
from urllib.parse import urlparse
import webbrowser
import zipfile
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LOCK = threading.RLock()
TOKEN = secrets.token_urlsafe(32)
JOB = {"running": False, "done": 0, "total": 0, "date": None, "errors": [],
       "scope": "all", "callType": "normal"}
QUEUE = []
PREFS = {"days": 3, "colors": {}, "merges": {}, "sorts": {}, "manual": [],
         "stockColors": {}, "stockNotes": {}, "themeNotes": {}, "themeOrders": {}, "columnWidths": {}}


class MatrixHTML(HTMLParser):
    def __init__(self):
        super().__init__(); self.rows = []; self.row = []; self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr": self.row = []
        if tag in ("td", "th"): self.cell = ""
        if tag == "br" and self.cell is not None: self.cell += "\n"

    def handle_data(self, data):
        if self.cell is not None: self.cell += data

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(self.cell.strip()); self.cell = None
        if tag == "tr": self.rows.append(self.row)


def read_xlsx(content):
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        if sum(i.file_size for i in z.infolist()) > 40_000_000:
            raise ValueError("Excel 解压后过大，请使用单日板块矩阵。")
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            strings = ["".join(x.itertext()) for x in root.findall("s:si", ns)]
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        sheet = wb.find("s:sheets/s:sheet", ns)
        relid = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = next(x.attrib["Target"] for x in rels if x.attrib["Id"] == relid)
        target = target.lstrip("/") if target.startswith("/") else "xl/" + target
        root = ET.fromstring(z.read(target))
        rows = []
        for r in root.findall("s:sheetData/s:row", ns):
            row = []
            for c in r.findall("s:c", ns):
                col = 0
                for letter in re.match(r"[A-Z]+", c.attrib["r"])[0]: col = col * 26 + ord(letter) - 64
                while len(row) < col: row.append("")
                v = c.find("s:v", ns)
                val = v.text if v is not None else ""
                if c.attrib.get("t") == "s": val = strings[int(val)]
                elif c.attrib.get("t") == "inlineStr": val = "".join(c.find("s:is", ns).itertext())
                row[col - 1] = val or ""
            rows.append(row)
        return rows


def parse_matrix(filename, content):
    match = re.search(r"(20\d{2})[-年_.](\d{1,2})[-月_.](\d{1,2})", filename)
    if not match: raise ValueError("文件名需要包含日期，例如 板块矩阵_2026-11-13.xls。")
    day = dt.date(*map(int, match.groups())).isoformat()
    if content.startswith(b"PK"):
        rows = read_xlsx(content)
    else:
        try: raw = content.decode("utf-8-sig")
        except UnicodeDecodeError: raise ValueError("暂不支持旧版二进制 .xls，请另存为 .xlsx 后导入。")
        if "<table" not in raw.lower(): raise ValueError("没有找到板块矩阵表格，请上传原始导出文件或 .xlsx。")
        parser = MatrixHTML(); parser.feed(raw); rows = parser.rows
    header_at = next((i for i, r in enumerate(rows) if r and "题材" in str(r[0])), None)
    if header_at is None: raise ValueError("没有找到“题材 / 指标”表头。")
    rows = rows[header_at:]; themes = [str(x).strip() for x in rows[0][1:]]
    if not themes or any(not x for x in themes) or len(set(themes)) != len(themes):
        raise ValueError("题材表头为空或重复，请检查表格。")
    stocks = {}; counts = {t: 0 for t in themes}; reported = {}; amounts = {}
    for row in rows[1:]:
        if not row: continue
        label = str(row[0]).strip()
        if label in ("涨停数", "成交额"):
            for i, t in enumerate(themes, 1):
                if i < len(row):
                    if label == "涨停数" and str(row[i]).strip(): reported[t] = int(float(row[i]))
                    elif label == "成交额": amounts[t] = str(row[i])
            continue
        board = 1 if label == "首板" else int(re.fullmatch(r"(\d+)板", label)[1]) if re.fullmatch(r"(\d+)板", label) else None
        if board is None: continue
        for i, theme in enumerate(themes, 1):
            value = str(row[i]) if i < len(row) else ""
            names = [n.strip() for n in re.split(r"[\n\r、,，;；]+", value) if n.strip() and n.strip() not in ("-", "—")]
            for name in dict.fromkeys(names):
                if len(name) > 30: raise ValueError(f"无法识别股票单元格：{name[:30]}")
                if name in stocks and stocks[name]["board"] != board: raise ValueError(f"{name} 同时出现不同板数，请检查表格。")
                stock = stocks.setdefault(name, {"name": name, "board": board, "themes": []})
                if theme not in stock["themes"]: stock["themes"].append(theme); counts[theme] += 1
    if not stocks: raise ValueError("表格中没有识别到个股。")
    issues = [f"{t}：表头 {reported[t]} 只，实际 {counts[t]} 只" for t in reported if counts[t] != reported[t]]
    return {"date": day, "source": Path(filename).name, "stocks": list(stocks.values()), "themeOrder": themes,
            "reportedCounts": reported, "reportedAmounts": amounts, "complete": not issues, "importWarnings": issues,
            "metrics": {}, "dataStatus": "pending", "dataMessage": "等待补充问财数据",
            "rebound": {"status": "pending", "stocks": [], "message": "等待查询今日反包"}}


def load_state():
    path = DATA / "state.json"
    if path.exists():
        state = json.loads(path.read_text())
        state["preferences"] = {**copy.deepcopy(PREFS), **state.get("preferences", {})}
        return state
    return {"version": 1, "days": [], "preferences": copy.deepcopy(PREFS)}


def save_state(state):
    DATA.mkdir(parents=True, exist_ok=True)
    temp = DATA / "state.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    temp.replace(DATA / "state.json")


def import_days(files):
    parsed = [parse_matrix(name, content) for name, content in files]
    if len({d["date"] for d in parsed}) != len(parsed): raise ValueError("这批文件包含重复日期，请每个日期只选择一份。")
    with LOCK:
        state = load_state(); days = {d["date"]: d for d in state["days"]}
        for d in parsed:
            if d["date"] in days:
                old = days[d["date"]]
                for key in ("metrics", "dataStatus", "dataMessage", "fetchedAt", "query", "rebound"):
                    if key in old: d[key] = old[key]
            days[d["date"]] = d
        state["days"] = sorted(days.values(), key=lambda x: x["date"]); save_state(state)
    return [d["date"] for d in parsed]


def tls_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError: return ssl.create_default_context()


def query_text(date):
    y, m, d = map(int, date.split("-")); prefix = f"{y}年{m}月{d}日"
    return "；".join(["非ST", prefix + "涨停"] + [prefix + field for field in
        ("自由流通股占总股本比例", "自由流通市值", "收盘价", "首次涨停时间", "最后涨停时间", "成交额", "封成比")] + ["省份"])


def previous_trading_dates(date, count=2):
    """Return earlier trading dates in chronological order using the bundled SSE calendar."""
    calendar = json.loads((ROOT / "calendar.json").read_text())
    day = dt.date.fromisoformat(date); result = []
    for _ in range(90):
        day -= dt.timedelta(days=1); iso = day.isoformat()
        year = calendar.get("years", {}).get(str(day.year))
        if not year: raise ValueError(f"缺少 {day.year} 年交易日历，暂不能计算今日反包。")
        if day.weekday() < 5 and iso not in year.get("closed_weekdays", []):
            result.append(iso)
            if len(result) == count: return list(reversed(result))
    raise ValueError("无法确定前两个交易日，暂不能计算今日反包。")


def rebound_query_text(date):
    two_back, previous = previous_trading_dates(date, 2)
    cn = lambda value: f"{int(value[:4])}年{int(value[5:7])}月{int(value[8:10])}日"
    return "，".join([f"{cn(date)}主板非ST", f"{cn(two_back)}涨停", f"{cn(previous)}非涨停",
        f"{cn(date)}涨停", "股票简称", "股票代码"]), [two_back, previous]


def request_wencai(query, page=1):
    key = os.environ.get("IWENCAI_API_KEY", "")
    if not key: raise ValueError("请先在“数据设置”中配置问财密钥。")
    call_type = JOB.get("callType", "normal") if JOB.get("running") else "normal"
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json",
        "X-Claw-Call-Type": call_type, "X-Claw-Skill-Id": "hithink-astock-selector", "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none", "X-Claw-Plugin-Version": "none", "X-Claw-Trace-Id": secrets.token_hex(32)}
    body = json.dumps({"query": query, "page": str(page), "limit": "10", "is_cache": "1", "expand_index": "true"}).encode()
    curl = shutil.which("curl")
    if curl:
        # Use the operating system's trusted TLS roots. Credentials enter curl through stdin,
        # never argv, files, responses or logs. A complete JSON body is required even on timeout.
        config = "\n".join("header = " + json.dumps(k + ": " + v) for k, v in headers.items())
        proc = subprocess.run([curl, "-4", "--noproxy", "openapi.iwencai.com", "--config", "-", "--compressed", "--silent", "--show-error",
            "--connect-timeout", "8", "--max-time", "30", "--data-binary", body.decode(),
            "--write-out", "\n__STATUS__:%{http_code}", "https://openapi.iwencai.com/v1/query2data"],
            input=config, text=True, capture_output=True, timeout=35)
        content, _, status = proc.stdout.rpartition("\n__STATUS__:")
        if status and status not in ("200", "000"):
            raise ValueError(f"问财请求失败（HTTP {status}），请检查密钥、权限或额度。")
        try: result = json.loads(content)
        except json.JSONDecodeError:
            raise ValueError("问财连接超时或响应不完整，已保留原始名单，请稍后重试。") from None
        if not isinstance(result, dict): raise ValueError("问财返回格式暂不支持。")
        return result
    request = urllib.request.Request("https://openapi.iwencai.com/v1/query2data", data=body, headers=headers)
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=tls_context()))
        with opener.open(request, timeout=30) as res:
            content = b""
            while len(content) < 5_000_000:
                try: chunk = res.read1(65536)
                except http.client.IncompleteRead as e: chunk = e.partial
                content += chunk
                try:
                    result = json.loads(content)
                    break
                except (json.JSONDecodeError, UnicodeDecodeError):
                    if not chunk: raise ValueError("问财响应不完整，请稍后重试。")
            else: raise ValueError("问财单页响应过大，请稍后重试。")
    except urllib.error.HTTPError as e: raise ValueError(f"问财请求失败（HTTP {e.code}），请检查密钥、权限或额度。") from None
    except (urllib.error.URLError, TimeoutError): raise ValueError("问财连接失败，请检查网络或稍后重试。") from None
    if not isinstance(result, dict): raise ValueError("问财返回格式暂不支持。")
    return result


def numeric(v):
    if v is None or str(v).strip() in ("", "--", "-", "None"): return None
    try:
        text = str(v).replace(",", "").replace("%", "").strip()
        scale = 1e8 if "亿" in text else 1e4 if "万" in text else 1
        n = float(re.sub(r"[亿元万股元]", "", text)) * scale
        return n if n == n and abs(n) != float("inf") else None
    except (TypeError, ValueError): return None


def normalize_name(name):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(name)))


def normalize_rows(rows, day):
    target = day.replace("-", ""); output = {}
    fields = {"floatRatio": ("自由流通股占总股本比例",), "floatCap": ("自由流通市值",),
        "price": ("收盘价", "收盘价:不复权", "收盘价_不复权"), "firstLimit": ("首次涨停时间",), "lastLimit": ("最后涨停时间", "最终涨停时间"),
        "amount": ("成交额",), "sealRatio": ("封成比", "涨停封单量占成交量比")}
    for row in rows:
        name = row.get("股票简称") or row.get("股票名称") or row.get("简称")
        code = row.get("股票代码") or row.get("证券代码") or row.get("code")
        if not name: continue
        item = {"name": name, "code": code, "source": "同花顺问财", "date": day}
        province = row.get("省份") or row.get("所属省份")
        if province is None:
            province = next((v for k, v in row.items() if k.startswith("省份[")), None)
        item["province"] = str(province).strip() if province is not None and str(province).strip() not in ("", "--", "None") else None
        for field, aliases in fields.items():
            hits = [(k, v) for k, v in row.items() if any(k == a + "[" + target + "]" or (k.startswith(a + "[") and target in k) for a in aliases)]
            # Only accept explicitly dated values; never substitute current prices for historical data.
            value = hits[0][1] if hits else None
            if field in ("firstLimit", "lastLimit"):
                time_match = re.search(r"\b(\d{2}:\d{2}:\d{2})\b", str(value)) if value is not None else None
                if time_match:
                    item[field] = time_match[1]
                else:
                    try:
                        timestamp = float(value)
                        if abs(timestamp) > 10_000_000_000: timestamp /= 1000
                        item[field] = dt.datetime.fromtimestamp(timestamp, dt.timezone(dt.timedelta(hours=8))).strftime("%H:%M:%S") if abs(timestamp) > 1_000_000_000 else None
                    except (TypeError, ValueError, OverflowError, OSError):
                        item[field] = None
            else: item[field] = numeric(value)
        output[normalize_name(name)] = item
    return output


def fetch_day(date):
    query = query_text(date); all_rows = []; seen = set(); seen_codes = set(); page = 1; columns = []; expected = None
    while True:
        result = request_wencai(query, page)
        rows = result.get("datas")
        if rows is None and isinstance(result.get("data"), dict):
            result = result["data"]; rows = result.get("datas")
        if not isinstance(rows, list): raise ValueError("问财未返回可识别的个股列表，请检查查询权限。")
        if not rows:
            if expected is not None and len(all_rows) < expected: raise ValueError("问财分页提前结束，已保留之前的数据，请稍后重试。")
            break
        columns = result.get("columns", columns)
        signature = json.dumps(rows, ensure_ascii=False, sort_keys=True)
        if signature in seen: raise ValueError("问财分页重复，未将不完整结果标为完成。")
        seen.add(signature)
        for row in rows:
            identifier = row.get("股票代码") or row.get("股票简称")
            if not identifier: raise ValueError("问财返回缺少股票标识，请稍后重试。")
            if identifier in seen_codes: raise ValueError("问财分页出现重复个股，已保留之前的数据，请稍后重试。")
            seen_codes.add(identifier); all_rows.append(row)
        total = int(result.get("code_count", len(all_rows)))
        expected = total
        if len(all_rows) >= total: break
        page += 1
        if page > 100: raise ValueError("问财分页过多，已停止查询。")
    if not all_rows: raise ValueError("问财未返回该日数据，保留原始名单；可稍后重试。")
    metrics = normalize_rows(all_rows, date)
    price_col = next((c for c in columns if c.get("key", "").startswith("收盘价[")), {})
    for item in metrics.values():
        item["priceBasis"] = price_col.get("index_name", "收盘价")
    with LOCK:
        state = load_state(); day = next(d for d in state["days"] if d["date"] == date)
        merged = dict(day.get("metrics", {})); merged.update(metrics); day["metrics"] = merged
        matched = sum(normalize_name(s["name"]) in metrics for s in day["stocks"])
        valid_fields = ("floatRatio", "floatCap", "price", "firstLimit", "lastLimit", "amount", "sealRatio", "province")
        full = sum(all(metrics.get(normalize_name(s["name"]), {}).get(f) is not None for f in valid_fields) for s in day["stocks"])
        day["dataStatus"] = "ready" if full == len(day["stocks"]) else "partial"
        day["dataMessage"] = f"匹配 {matched}/{len(day['stocks'])} 只，完整字段 {full} 只"
        day["fetchedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(); day["query"] = query
        day["metricColumns"] = columns
        save_state(state)
    return {"matched": matched, "complete": full, "returned": len(all_rows)}


def fetch_rebound_day(date):
    """Persist the day's main-board non-ST limit-up rebound screen from iWencai."""
    query, previous_dates = rebound_query_text(date)
    all_rows = []; seen_pages = set(); seen_stocks = set(); page = 1; expected = None
    while True:
        result = request_wencai(query, page)
        rows = result.get("datas")
        if rows is None and isinstance(result.get("data"), dict):
            result = result["data"]; rows = result.get("datas")
        if not isinstance(rows, list): raise ValueError("问财未返回可识别的今日反包列表。")
        if not rows:
            if expected is not None and len(all_rows) < expected: raise ValueError("今日反包分页提前结束，请稍后重试。")
            break
        signature = json.dumps(rows, ensure_ascii=False, sort_keys=True)
        if signature in seen_pages: raise ValueError("今日反包分页重复，请稍后重试。")
        seen_pages.add(signature)
        for row in rows:
            name = str(row.get("股票简称") or row.get("股票名称") or row.get("简称") or "").strip()
            code = str(row.get("股票代码") or row.get("证券代码") or "").strip()
            board = str(row.get("上市板块") or "").strip()
            if not name or not code: raise ValueError("今日反包结果缺少股票简称或代码。")
            identifier = code or normalize_name(name)
            if identifier in seen_stocks: raise ValueError("今日反包分页出现重复个股，请稍后重试。")
            seen_stocks.add(identifier)
            # Keep the screen defensive even if the provider broadens a parsed condition.
            if board and board != "主板": continue
            if re.match(r"^\*?ST", name, re.I): continue
            all_rows.append({"name": name, "code": code, "board": board or "主板"})
        total = int(result.get("code_count", len(all_rows)))
        expected = total
        if len(seen_stocks) >= total: break
        page += 1
        if page > 100: raise ValueError("今日反包分页过多，已停止查询。")
    record = {"status": "ready", "stocks": all_rows, "count": len(all_rows), "query": query,
        "previousDates": previous_dates, "source": "同花顺问财",
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "message": f"问财筛选到 {len(all_rows)} 只" if all_rows else "问财筛选结果为空"}
    with LOCK:
        state = load_state(); day = next(d for d in state["days"] if d["date"] == date)
        day["rebound"] = record; save_state(state)
    return record


def save_rebound_error(date, message):
    with LOCK:
        state = load_state(); day = next(d for d in state["days"] if d["date"] == date)
        old = day.get("rebound", {})
        day["rebound"] = {**old, "status": "error", "message": message, "stocks": old.get("stocks", [])}
        save_state(state)


def sync_worker():
    while True:
        with LOCK:
            if not QUEUE:
                JOB["running"] = False; JOB["date"] = None
                return
            date = QUEUE.pop(0); JOB["date"] = date; scope = JOB.get("scope", "all")
        if scope in ("all", "metrics"):
            try: fetch_day(date)
            except Exception as e:
                msg = str(e) if isinstance(e, ValueError) else "数据请求未完成，请稍后重试。"
                with LOCK:
                    JOB["errors"].append({"date": date, "scope": "metrics", "message": msg})
                    state = load_state(); day = next(d for d in state["days"] if d["date"] == date)
                    day["dataMessage"] = msg; day["dataStatus"] = "partial" if day.get("metrics") else "error"; save_state(state)
        if scope in ("all", "rebound"):
            try: fetch_rebound_day(date)
            except Exception as e:
                msg = str(e) if isinstance(e, ValueError) else "今日反包查询未完成，请稍后重试。"
                save_rebound_error(date, msg)
                with LOCK: JOB["errors"].append({"date": date, "scope": "rebound", "message": msg})
        with LOCK: JOB["done"] += 1


def start_sync(dates, scope="all", call_type="normal"):
    with LOCK:
        if not os.environ.get("IWENCAI_API_KEY"): raise ValueError("请先配置问财密钥。")
        if scope not in ("all", "metrics", "rebound"): raise ValueError("无效的数据补充范围。")
        if call_type not in ("normal", "retry"): raise ValueError("无效的问财调用类型。")
        known = {d["date"] for d in load_state()["days"]}
        dates = list(dict.fromkeys(dates))
        if not dates or any(d not in known for d in dates): raise ValueError("没有可补充的日期。")
        if JOB["running"]:
            if JOB.get("scope", "all") != scope or JOB.get("callType", "normal") != call_type:
                raise ValueError("当前数据补充任务的范围不同，请等待完成后重试。")
            extra = [d for d in dates if d != JOB["date"] and d not in QUEUE]
            QUEUE.extend(extra); JOB["total"] += len(extra)
            return
        QUEUE[:] = dates
        JOB.update(running=True, done=0, total=len(dates), date=None, errors=[], scope=scope, callType=call_type)
    threading.Thread(target=sync_worker, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def respond(self, value, status=200):
        content = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(content)))
        self.end_headers(); self.wfile.write(content)

    def host_ok(self):
        return self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

    def do_GET(self):
        if not self.host_ok(): return self.respond({"error": "无效主机"}, 403)
        path = urlparse(self.path).path
        if path == "/api/state":
            with LOCK:
                state = load_state(); state["token"] = TOKEN; state["configured"] = bool(os.environ.get("IWENCAI_API_KEY")); state["job"] = copy.deepcopy(JOB)
                state["calendar"] = json.loads((ROOT / "calendar.json").read_text())
            return self.respond(state)
        if path == "/api/job":
            with LOCK: return self.respond(copy.deepcopy(JOB))
        allowed = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
            "/engine.mjs": ("engine.mjs", "text/javascript"), "/style.css": ("style.css", "text/css")}
        if path not in allowed: return self.respond({"error": "未找到"}, 404)
        filename, mime = allowed[path]; body = (ROOT / "static" / filename).read_bytes()
        self.send_response(200); self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Cache-Control", "no-cache"); self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        if not self.host_ok() or self.headers.get("X-Review-Token") != TOKEN: return self.respond({"error": "请刷新页面后重试"}, 403)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"): return self.respond({"error": "无效来源"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 20_000_000: raise ValueError("上传内容为空或超过 20 MB。")
            payload = json.loads(self.rfile.read(length)); path = urlparse(self.path).path
            if path == "/api/import":
                files = [(x["name"], base64.b64decode(x["content"], validate=True)) for x in payload["files"]]
                dates = import_days(files)
                if os.environ.get("IWENCAI_API_KEY"): start_sync(dates)
                return self.respond({"dates": dates})
            if path == "/api/preferences":
                p = payload["preferences"]
                if not isinstance(p, dict) or not 1 <= int(p.get("days", 3)) <= 7: raise ValueError("无效的显示设置。")
                with LOCK:
                    state = load_state()
                    state["preferences"] = {k: p.get(k, state["preferences"].get(k, copy.deepcopy(v))) for k, v in PREFS.items()}
                    save_state(state)
                return self.respond({"ok": True})
            if path == "/api/credential":
                key = str(payload.get("key", "")).strip()
                if not key or len(key) > 1000 or "\n" in key: raise ValueError("请输入有效的单个问财密钥。")
                os.environ["IWENCAI_API_KEY"] = key
                return self.respond({"configured": True})
            if path == "/api/sync":
                start_sync(payload["dates"], payload.get("scope", "all"), payload.get("callType", "normal")); return self.respond({"ok": True})
            return self.respond({"error": "未找到"}, 404)
        except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as e:
            return self.respond({"error": str(e)}, 400)
        except Exception:
            return self.respond({"error": "操作没有完成，请检查文件格式后重试。"}, 500)


def main():
    global DATA
    parser = argparse.ArgumentParser(); parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--import-dir"); parser.add_argument("--data-dir"); parser.add_argument("--ask-key", action="store_true")
    parser.add_argument("--sync", action="store_true"); parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    if args.data_dir: DATA = Path(args.data_dir)
    if args.import_dir:
        files = sorted(Path(args.import_dir).glob("*.xls*"))
        dates = import_days([(p.name, p.read_bytes()) for p in files]); print(f"已导入 {len(dates)} 个交易日", flush=True)
    if args.ask_key: os.environ["IWENCAI_API_KEY"] = getpass.getpass("问财密钥（隐藏输入，仅本次运行有效）: ")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    if args.sync:
        dates = [d["date"] for d in reversed(load_state()["days"]) if d.get("dataStatus") != "ready" or
                 any(not d.get("metrics", {}).get(normalize_name(s["name"]), {}).get("province") for s in d["stocks"])]
        if dates: start_sync(dates)
    url = f"http://127.0.0.1:{args.port}"
    print(f"复盘看板已启动：{url}", flush=True)
    if args.open: webbrowser.open(url)
    server.serve_forever()


if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\n复盘看板已停止，数据已保留。")
