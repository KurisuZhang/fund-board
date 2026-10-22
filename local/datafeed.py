"""数据抓取（本地 Python 版）。

数据源（均为免费公开接口，2026-10 实测可用）：
  * 腾讯行情  qt.gtimg.cn            实时快照（GBK）
  * 腾讯行情  web.ifzq.gtimg.cn      个股/ETF 日线（前复权）
  * 新浪财经  money.finance.sina.com.cn  指数日线（长历史）
  * 新浪期货  hq.sinajs.cn / stock2.finance.sina.com.cn  碳酸锂期货实时价 + 日线
  * 新浪新闻  search.sina.com.cn / feed.mix.sina.com.cn / zhibo.sina.com.cn  关键词新闻

东方财富接口在部分网络环境下返回空响应，故整体不依赖它。
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TAG_RE = re.compile(r"<[^>]+>")

TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q={codes}"
TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{days},qfq"
SINA_KLINE_URL = (
    "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/"
    "CN_MarketData.getKLineData?symbol={symbol}&scale=240&ma=no&datalen={days}"
)
SINA_FUTURES_KLINE_URL = (
    "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/"
    "InnerFuturesNewService.getDailyKLine?symbol={symbol}"
)
SINA_FUTURES_HQ_URL = "https://hq.sinajs.cn/list=nf_{symbol}"
SINA_SEARCH_URL = "https://search.sina.com.cn/api/search"
SINA_ROLL_URL = "https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num={num}&page={page}"
SINA_ZHIBO_URL = (
    "https://zhibo.sina.com.cn/api/zhibo/feed?page={page}&page_size=30&zhibo_id=152&tag_id=0&dire=f&dpc=1"
)


class FeedError(RuntimeError):
    pass


def strip_tags(text: str) -> str:
    return TAG_RE.sub("", text or "").strip()


class DataFeed:
    def __init__(self, rules: dict, timeout: int = 15, retries: int = 3):
        self.rules = rules
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA})
        self.warnings: list[str] = []
        self.sources: list[str] = []

    # ---------------------------------------------------------------- 基础
    def _get(self, url: str, referer: str | None = None, decode: str | None = None) -> str:
        last = None
        for attempt in range(self.retries):
            try:
                headers = {"Referer": referer} if referer else {}
                resp = self.session.get(url, headers=headers, timeout=self.timeout)
                if resp.status_code != 200:
                    raise FeedError("HTTP %s" % resp.status_code)
                if decode:
                    return resp.content.decode(decode, errors="replace")
                return resp.text
            except Exception as exc:  # noqa: BLE001
                last = exc
                if attempt < self.retries - 1:
                    time.sleep(1.2 * (attempt + 1))
        raise FeedError("请求失败 %s: %s" % (url.split("?")[0], last))

    def _get_json(self, url: str, referer: str | None = None):
        raw = self._get(url, referer=referer)
        raw = raw.strip()
        if raw.startswith("/*"):
            idx = raw.find("*/")
            if idx >= 0:
                raw = raw[idx + 2 :].strip()
        if raw.startswith("var ") or "=(" in raw:
            start, end = raw.find("("), raw.rfind(")")
            if start >= 0 and end > start:
                raw = raw[start + 1 : end]
        return json.loads(raw)

    # ------------------------------------------------------------ 行情快照
    def quotes(self, codes: list[str]) -> dict:
        raw = self._get(TENCENT_QUOTE_URL.format(codes=",".join(codes)), decode="gbk")
        self._mark("腾讯行情")
        out = {}
        for line in raw.split(";"):
            line = line.strip()
            if "=" not in line or '"' not in line:
                continue
            var_name = line.split("=", 1)[0].strip()
            code = var_name[2:] if var_name.startswith("v_") else ""
            body = line.split("=", 1)[1].strip().strip('"')
            f = body.split("~")
            if len(f) < 50 or not code:
                continue
            if len(f) > 2 and f[2]:
                code = code if code.startswith(("sh", "sz", "bj")) else f[2]
            out[code] = {
                "code": code,
                "name": f[1],
                "price": _f(f[3]),
                "prevClose": _f(f[4]),
                "open": _f(f[5]),
                "high": _f(f[33]),
                "low": _f(f[34]),
                "changePct": _f(f[32]),
                "volumeHand": _f(f[36]),
                "amountWan": _f(f[37]),
                "turnoverPct": _f(f[38]),
                "pe": _f(f[39]),
                "floatCapYi": _f(f[44]),
                "marketCapYi": _f(f[45]),
                "pb": _f(f[46]),
                "yearHigh": _f(f[47]),
                "yearLow": _f(f[48]),
                "time": f[30],
            }
        return out

    # ---------------------------------------------------------------- 日线
    def stock_kline(self, code: str, days: int) -> list[dict]:
        """个股/ETF 日线：优先腾讯（含前复权），腾讯限流/异常时回落新浪（不复权）。"""
        try:
            data = self._get_json(TENCENT_KLINE_URL.format(code=code, days=days),
                                  referer="https://gu.qq.com/")
            node = (data.get("data") or {}).get(code) or {}
            rows = node.get("qfqday") or node.get("day") or []
            bars = _tencent_rows(rows)
            if bars:
                self._mark("腾讯日线")
                return self._adjust(bars, code)
        except FeedError:
            pass
        bars = self.index_kline(code, days)  # 新浪接口对个股/ETF 同样可用
        self._mark("新浪日线(回落)")
        self.warnings.append("%s 腾讯日线不可用，已回落新浪不复权日线" % code)
        return self._adjust(bars, code)

    def _adjust(self, bars: list[dict], code: str) -> list[dict]:
        fixed, events = adjust_splits(bars, code)
        for ev in events:
            msg = "%s 于 %s 发生除权（%.3f→%.3f），已按前复权修复历史价格" % (
                code, ev["date"], ev["prev_close"], ev["close"])
            if msg not in self.warnings:
                self.warnings.append(msg)
        return fixed

    def index_kline(self, symbol: str, days: int) -> list[dict]:
        rows = self._get_json(SINA_KLINE_URL.format(symbol=symbol, days=days),
                              referer="https://finance.sina.com.cn")
        self._mark("新浪指数日线")
        bars = []
        for r in rows:
            c = float(r["close"])
            shares = float(r.get("volume") or 0.0)
            bars.append({"d": r["day"], "o": float(r["open"]), "h": float(r["high"]),
                         "l": float(r["low"]), "c": c, "v": shares / 100.0,
                         "a": shares * c})
        return bars

    # ---------------------------------------------------------------- 期货
    def futures_realtime(self, symbol: str = "LC0") -> dict | None:
        try:
            raw = self._get(SINA_FUTURES_HQ_URL.format(symbol=symbol),
                            referer="https://finance.sina.com.cn", decode="gbk")
        except FeedError as exc:
            self.warnings.append("期货实时价获取失败：%s" % exc)
            return None
        if '"' not in raw:
            return None
        body = raw.split('="', 1)[1].strip('";\n')
        f = body.split(",")
        if len(f) < 18 or not f[8]:
            return None
        self._mark("新浪期货实时")
        return {
            "name": f[0],
            "price": _f(f[8]),
            "open": _f(f[2]),
            "high": _f(f[3]),
            "low": _f(f[4]),
            "prevSettle": _f(f[9]),
            "prevClose": _f(f[10]),
            "openInterest": _f(f[13]),
            "volume": _f(f[14]),
            "date": f[17],
        }

    def futures_kline(self, symbol: str = "LC0") -> list[dict]:
        rows = self._get_json(SINA_FUTURES_KLINE_URL.format(symbol=symbol),
                              referer="https://finance.sina.com.cn")
        self._mark("新浪期货日线")
        bars = []
        for r in rows:
            c = float(r["c"])
            v = float(r.get("v") or 0.0)
            bars.append({"d": r["d"], "o": float(r["o"]), "h": float(r["h"]),
                         "l": float(r["l"]), "c": c, "v": v, "a": None})
        return bars

    # ---------------------------------------------------------------- 新闻
    def news(self) -> list[dict]:
        cfg = self.rules["fundamental"]["news"]
        relevance = cfg.get("relevance") or []
        items: list[dict] = []
        queries = cfg.get("search_queries") or ["储能电池"]
        for q in queries[:4]:
            try:
                data = self._get_json(
                    "%s?q=%s&size=30&page=1" % (SINA_SEARCH_URL, requests.utils.quote(q)),
                    referer="https://search.sina.com.cn/",
                )
                for it in (data.get("data") or {}).get("list") or []:
                    items.append({
                        "ts": float(it.get("ctime") or 0),
                        "title": strip_tags(it.get("title") or ""),
                        "url": it.get("url") or "",
                        "source": "search",
                    })
                self._mark("新浪新闻搜索")
            except FeedError as exc:
                self.warnings.append("新闻搜索失败(%s)：%s" % (q, exc))

        for page in (1, 2):
            try:
                url = SINA_ROLL_URL.format(num=50, page=page)
                data = self._get_json(url, referer="https://finance.sina.com.cn")
                for it in (data.get("result") or {}).get("data") or []:
                    items.append({
                        "ts": float(it.get("ctime") or 0),
                        "title": strip_tags(it.get("title") or ""),
                        "url": it.get("url") or "",
                        "source": "roll",
                    })
                self._mark("新浪滚动新闻")
            except FeedError as exc:
                self.warnings.append("滚动新闻失败(page%s)：%s" % (page, exc))

        for page in (1, 2):
            try:
                data = self._get_json(SINA_ZHIBO_URL.format(page=page),
                                      referer="https://finance.sina.com.cn")
                feed = ((data.get("result") or {}).get("data") or {}).get("feed") or {}
                for it in feed.get("list") or []:
                    items.append({
                        "ts": _parse_ts(it.get("create_time")),
                        "title": strip_tags(it.get("rich_text") or ""),
                        "url": it.get("docurl") or "",
                        "source": "zhibo",
                    })
                self._mark("新浪7x24快讯")
            except FeedError as exc:
                self.warnings.append("快讯失败(page%s)：%s" % (page, exc))

        seen = set()
        filtered = []
        for it in sorted(items, key=lambda x: -x["ts"]):
            title = it["title"]
            if not title:
                continue
            key = title[:40]
            if key in seen:
                continue
            if relevance and not any(k in title for k in relevance):
                continue
            seen.add(key)
            filtered.append(it)
        return filtered

    # ------------------------------------------------------------ 归一化输入
    def _mark(self, name: str) -> None:
        if name not in self.sources:
            self.sources.append(name)

    def build_input(self) -> tuple[dict, dict]:
        rules = self.rules
        inst = rules["instruments"]
        fetch = rules["fetch"]
        etf_code = inst["etf"]["code"]
        watch = [w["code"] for w in rules["watchlist"]]

        snap = self.quotes([etf_code] + watch)
        etf_snap = snap.get(etf_code) or {}

        bars = self.stock_kline(etf_code, fetch["etf_days"])
        if not bars:
            raise FeedError("ETF 日线为空，无法计算")

        try:
            index_bars = self.index_kline(inst["index"]["code"], fetch["index_days"])
        except FeedError as exc:
            self.warnings.append("指数日线缺失：%s" % exc)
            index_bars = []

        try:
            bench_bars = self.index_kline(inst["bench"]["code"], fetch["bench_days"])
        except FeedError as exc:
            self.warnings.append("基准指数缺失：%s" % exc)
            bench_bars = []

        try:
            fut_bars = self.futures_kline(inst["futures"]["symbol"])
        except FeedError as exc:
            self.warnings.append("期货日线缺失：%s" % exc)
            fut_bars = []
        fut_rt = self.futures_realtime(inst["futures"]["symbol"])
        if fut_rt and fut_bars and fut_rt["date"] == fut_bars[-1]["d"]:
            fut_bars[-1]["c"] = fut_rt["price"]
            fut_bars[-1]["h"] = max(fut_bars[-1]["h"], fut_rt["high"] or 0)
            fut_bars[-1]["l"] = min(fut_bars[-1]["l"], fut_rt["low"] or fut_bars[-1]["l"])

        stocks = []
        with ThreadPoolExecutor(max_workers=fetch["stock_concurrency"]) as pool:
            future_map = {pool.submit(self.stock_kline, w["code"], fetch["stock_days"]): w
                          for w in rules["watchlist"]}
            kbars: dict[str, list] = {}
            for fut, meta in future_map.items():
                try:
                    kbars[meta["code"]] = fut.result()
                except Exception as exc:  # noqa: BLE001
                    kbars[meta["code"]] = []
                    self.warnings.append("%s 日线缺失：%s" % (meta["name"], exc))

        for w in rules["watchlist"]:
            code = w["code"]
            q = snap.get(code) or {}
            stocks.append({
                "code": code,
                "name": w["name"],
                "price": q.get("price"),
                "changePct": q.get("changePct"),
                "pe": q.get("pe"),
                "marketCap": q.get("marketCapYi"),
                "turnoverPct": q.get("turnoverPct"),
                "bars": kbars.get(code) or [],
            })

        fallback = [w for w in self.warnings if "回落新浪" in w]
        if len(fallback) > 1:
            self.warnings = [w for w in self.warnings if "回落新浪" not in w]
            self.warnings.append("%d 只标的的腾讯日线不可用，已回落新浪不复权日线（不影响打分口径）" % len(fallback))

        try:
            news = self.news()
        except FeedError as exc:
            self.warnings.append("新闻全部失败：%s" % exc)
            news = []

        now = time.time()
        data_date = bars[-1]["d"] if bars else ""
        starred = sorted(stocks, key=lambda s: -(s.get("marketCap") or 0))[:10]
        snapshot_map = {s["code"]: s for s in stocks}

        inp = {
            "etf": {
                "code": etf_code,
                "name": inst["etf"]["name"],
                "price": etf_snap.get("price") or (bars[-1]["c"] if bars else None),
                "prevClose": etf_snap.get("prevClose"),
                "changePct": etf_snap.get("changePct"),
                "turnoverPct": etf_snap.get("turnoverPct"),
                "amountWan": etf_snap.get("amountWan"),
                "bars": bars,
            },
            "index": {"code": inst["index"]["code"], "name": inst["index"]["name"], "bars": index_bars},
            "bench": {"code": inst["bench"]["code"], "name": inst["bench"]["name"], "bars": bench_bars},
            "futures": {"symbol": inst["futures"]["symbol"], "name": inst["futures"]["name"],
                        "bars": fut_bars, "close": fut_bars[-1]["c"] if fut_bars else None,
                        "realtime": fut_rt},
            "stocks": stocks,
            "news": news,
            "asOf": now,
            "dataWarnings": [],
        }

        meta = {
            "fetchedAt": now,
            "dataDate": data_date,
            "isIntraday": bool(etf_snap.get("time")) and etf_snap["time"][:8] == time.strftime("%Y%m%d"),
            "sources": self.sources,
            "warnings": self.warnings,
            "watchlistTop": [{"code": s["code"], "name": s["name"], "changePct": s.get("changePct"),
                              "price": s.get("price")} for s in starred],
            "indexLevel": index_bars[-1]["c"] if index_bars else None,
            "benchLevel": bench_bars[-1]["c"] if bench_bars else None,
            "snapshotCount": len(snapshot_map),
        }
        return inp, meta



def limit_pct_of(code: str) -> float:
    """涨跌停幅度：科创板/创业板 20%，ETF 与主板 10%。"""
    body = code[2:] if code[:2] in ("sh", "sz", "bj") else code
    if body.startswith(("688", "300", "301")):
        return 0.20
    return 0.10


def adjust_splits(bars: list[dict], code: str) -> tuple[list[dict], list[dict]]:
    """识别并修复份额拆分/大比例分红造成的价格跳变（新浪不复权序列会遇到）。

    正常交易日不可能超出涨跌停；一旦单日变动超过 limit+2%，判定为除权事件，
    把此前所有价格乘以该比例、成交量除以该比例（成交额不变），得到前复权序列。
    """
    if len(bars) < 2:
        return bars, []
    limit = limit_pct_of(code)
    events: list[tuple[int, float]] = []
    for i in range(1, len(bars)):
        prev, cur = float(bars[i - 1]["c"]), float(bars[i]["c"])
        if prev <= 0 or cur <= 0:
            continue
        ratio = cur / prev
        if abs(ratio - 1.0) > limit + 0.02:
            events.append((i, ratio))
    if not events:
        return bars, []

    mult = [1.0] * len(bars)
    running = 1.0
    ev_map = dict(events)
    for i in range(len(bars) - 1, -1, -1):
        mult[i] = running
        if i in ev_map:
            running *= ev_map[i]

    out = []
    for i, b in enumerate(bars):
        nb = dict(b)
        if mult[i] != 1.0:
            for k in ("o", "h", "l", "c"):
                nb[k] = float(b[k]) * mult[i]
            nb["v"] = float(b.get("v") or 0.0) / mult[i]
        out.append(nb)

    info = [{"date": bars[i]["d"], "ratio": r,
             "prev_close": float(bars[i - 1]["c"]), "close": float(bars[i]["c"])}
            for i, r in events]
    return out, info


def _parse_ts(value) -> float:
    """新浪快讯的 create_time 是 'YYYY-MM-DD HH:MM:SS'（北京时间），滚动新闻是 epoch 字符串。"""
    import datetime

    if value is None or value == "":
        return 0.0
    text = str(value).strip()
    try:
        return float(text)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.datetime.strptime(text, fmt).replace(tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
            return dt.timestamp()
        except ValueError:
            continue
    return 0.0


def _f(value) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _tencent_rows(rows: list) -> list[dict]:
    """腾讯日线行格式：[日期, 开, 收, 高, 低, 成交量(手)]。"""
    bars = []
    for r in rows:
        if len(r) < 6:
            continue
        try:
            o, c, h, l, v = (float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]))
        except (TypeError, ValueError):
            continue
        bars.append({"d": r[0], "o": o, "h": h, "l": l, "c": c,
                     "v": v, "a": v * 100.0 * c})
    return bars
