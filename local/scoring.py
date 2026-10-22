"""打分引擎（纯函数）。

输入：归一化后的行情字典 + 规则字典（shared/scoring_rules.json）
输出：总分、信号灯、各子项得分与文字理由

与 assets/scoring.js 一一对应：同一份规则、同一运算顺序，
由 tests/test_parity.py 通过 quickjs 执行 JS 版本比对，防止两端口径漂移。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from indicators import (
    LIMIT,
    clamp,
    macd,
    pct_change,
    percentile_rank,
    pick_by_max,
    pick_by_min,
    round1,
    round_score,
    rsi,
    sma,
)


# ---------------------------------------------------------------- 输入约定
# input = {
#   "etf":     {"price": float, "changePct": float, "bars": [bar, ...]},
#   "index":   {"bars": [bar, ...]},
#   "bench":   {"bars": [bar, ...]},
#   "futures": {"bars": [bar, ...]},
#   "stocks":  [{"code","name","price","pe","marketCap","bars":[bar,...]}, ...],
#   "news":    [{"ts": epoch_seconds, "title": str}, ...],
#   "asOf":    epoch_seconds,
# }
# bar = {"d": "YYYY-MM-DD", "o","h","l","c": float, "v": float(手), "a": float(元)}
# ---------------------------------------------------------------------------


def _item(key: str, label: str, score: float, mx: float, value: str, reason: str,
          missing: bool = False) -> Dict:
    return {
        "key": key,
        "label": label,
        "score": score,
        "max": mx,
        "value": value,
        "reason": reason,
        "missing": missing,
    }


def _missing(key: str, label: str, mx: float, reason: str) -> Dict:
    return _item(key, label, 0.0, mx, "—", reason, missing=True)


def _closes(bars: List[dict]) -> List[float]:
    return [float(b["c"]) for b in bars]


def _amounts(bars: List[dict]) -> List[float]:
    out = []
    for b in bars:
        a = b.get("a")
        if a is None:
            a = float(b["c"]) * float(b.get("v") or 0.0) * 100.0
        out.append(float(a))
    return out


def _mean(vals: List[float]) -> float:
    return sum(vals) / len(vals)


# ------------------------------------------------------------------ 基本面
def score_cost(futures: Optional[dict], cfg: dict) -> Dict:
    mx = cfg["max"]
    bars = (futures or {}).get("bars") or []
    closes = _closes(bars)
    need = max(cfg["pct_window"], cfg["chg_window"], cfg["ma_window"]) + 1
    if len(closes) < need:
        return _missing("cost", cfg["label"], mx, "期货日线不足 %d 根，无法计算" % need)

    cur = closes[-1]
    pts: List[float] = []
    notes: List[str] = []

    ma = sma(closes, cfg["ma_window"])[-1]
    if cur >= ma:
        pts.append(cfg["trend_above"])
        notes.append("站上MA%d(+%d)" % (cfg["ma_window"], cfg["trend_above"]))
    else:
        pts.append(cfg["trend_below"])
        notes.append("跌破MA%d(%d)" % (cfg["ma_window"], cfg["trend_below"]))

    rank = percentile_rank(closes, cfg["pct_window"])
    if rank is not None:
        if rank <= cfg["pct_low_max"]:
            pts.append(cfg["pct_low_score"])
            notes.append("%d日分位%.0f%%处低位(+%d)" % (cfg["pct_window"], rank, cfg["pct_low_score"]))
        elif rank >= cfg["pct_high_min"]:
            pts.append(cfg["pct_high_score"])
            notes.append("%d日分位%.0f%%处高位(%d)" % (cfg["pct_window"], rank, cfg["pct_high_score"]))
        else:
            notes.append("%d日分位%.0f%%(中性)" % (cfg["pct_window"], rank))

    chg = pct_change(closes, cfg["chg_window"])
    if chg is not None:
        if cfg["chg_mild_min"] <= chg <= cfg["chg_mild_max"]:
            pts.append(cfg["chg_mild_score"])
            notes.append("%d日涨%.0f%%温和回暖(+%d)" % (cfg["chg_window"], chg, cfg["chg_mild_score"]))
        elif chg > cfg["chg_hot_min"]:
            pts.append(cfg["chg_hot_score"])
            notes.append("%d日涨%.0f%%过快、成本挤压(%d)" % (cfg["chg_window"], chg, cfg["chg_hot_score"]))
        elif chg < cfg["chg_weak_max"]:
            pts.append(cfg["chg_weak_score"])
            notes.append("%d日跌%.0f%%需求走弱(%d)" % (cfg["chg_window"], chg, cfg["chg_weak_score"]))
        else:
            notes.append("%d日涨跌%.1f%%(中性)" % (cfg["chg_window"], chg))

    score = clamp(sum(pts), -mx, mx)
    value = "%.0f 元/吨" % cur
    return _item("cost", cfg["label"], round_score(score), mx, value, "；".join(notes))


def score_valuation(stocks: List[dict], cfg: dict) -> Dict:
    mx = cfg["max"]
    valid = [
        s for s in stocks
        if s.get("pe") is not None
        and cfg["pe_min"] < float(s["pe"]) <= cfg["pe_max"]
        and (s.get("marketCap") or 0) > 0
    ]
    if len(valid) < 3:
        return _missing("valuation", cfg["label"], mx,
                        "有效PE样本不足（%d只），已剔除亏损/异常值" % len(valid))
    wsum = sum(float(s["marketCap"]) for s in valid)
    pe = sum(float(s["pe"]) * float(s["marketCap"]) for s in valid) / wsum
    bucket = pick_by_max(cfg["buckets"], pe)
    score = float(bucket["score"]) if bucket else 0.0
    reason = "加权PE %.1f 倍（样本%d只）%s" % (
        pe, len(valid), "，处于" + ("低估" if score > 0 else ("合理" if score == 0 else "偏贵")) + "区间"
    )
    return _item("valuation", cfg["label"], round_score(score), mx, "%.1f×" % pe, reason)


def score_breadth(stocks: List[dict], cfg: dict) -> Dict:
    mx = cfg["max"]
    above = 0
    total = 0
    for s in stocks:
        bars = s.get("bars") or []
        closes = _closes(bars)
        if len(closes) < cfg["ma_window"]:
            continue
        window = closes[-cfg["ma_window"]:]
        ma = sum(window) / len(window)
        total += 1
        if closes[-1] >= ma:
            above += 1
    if total < cfg["min_samples"]:
        return _missing("breadth", cfg["label"], mx,
                        "有效样本不足（%d/%d）" % (total, cfg["min_samples"]))
    pct = above / total * 100.0
    bucket = pick_by_min(cfg["buckets"], pct)
    score = float(bucket["score"]) if bucket else 0.0
    reason = "%d/%d 只站上MA%d = %.0f%%，%s" % (
        above, total, cfg["ma_window"], pct,
        "板块广度健康" if score > 0 else ("广度中性" if score == 0 else "多数个股失守均线"),
    )
    return _item("breadth", cfg["label"], round_score(score), mx, "%d/%d" % (above, total), reason)


def score_news(news: List[dict], as_of: float, cfg: dict) -> Dict:
    mx = cfg["max"]
    window_start = as_of - cfg["window_hours"] * 3600.0
    items = [n for n in (news or []) if float(n.get("ts", 0)) >= window_start]
    if len(items) < cfg["min_samples"]:
        return _missing("news", cfg["label"], mx,
                        "近%d小时相关新闻仅 %d 条，样本不足" % (cfg["window_hours"], len(items)))

    pos_kw = cfg["positive"]
    neg_kw = cfg["negative"]
    pos_cnt = 0
    neg_cnt = 0
    pos_hits: Dict[str, int] = {}
    neg_hits: Dict[str, int] = {}
    for it in items:
        title = str(it.get("title") or "")
        php = sum(1 for k in pos_kw if k in title)
        nhp = sum(1 for k in neg_kw if k in title)
        if php > nhp:
            pos_cnt += 1
            for k in pos_kw:
                if k in title:
                    pos_hits[k] = pos_hits.get(k, 0) + 1
        elif nhp > php:
            neg_cnt += 1
            for k in neg_kw:
                if k in title:
                    neg_hits[k] = neg_hits.get(k, 0) + 1
    net = (pos_cnt - neg_cnt) / len(items)
    score = round_score(cfg["scale"] * clamp(net / cfg["min_net_for_full"], -1.0, 1.0))
    score = clamp(score, -mx, mx)
    top_pos = sorted(pos_hits.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    top_neg = sorted(neg_hits.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    reason = "近%d小时 %d 条相关：正面%d / 负面%d" % (cfg["window_hours"], len(items), pos_cnt, neg_cnt)
    if top_pos:
        reason += "；正面词 " + ",".join("%s(%d)" % (k, v) for k, v in top_pos)
    if top_neg:
        reason += "；负面词 " + ",".join("%s(%d)" % (k, v) for k, v in top_neg)
    return _item("news", cfg["label"], score, mx, "%d 条" % len(items), reason)


# -------------------------------------------------------------------- 量能
def score_expansion(etf: dict, cfg: dict) -> Dict:
    mx = cfg["max"]
    bars = etf.get("bars") or []
    amounts = _amounts(bars)
    closes = _closes(bars)
    need = max(cfg["long_window"], cfg["short_window"]) + 1
    if len(amounts) < need or len(closes) < need:
        return _missing("expansion", cfg["label"], mx, "成交额序列不足 %d 根" % need)
    short_avg = _mean(amounts[-cfg["short_window"]:])
    long_avg = _mean(amounts[-cfg["long_window"]:])
    if long_avg <= 0:
        return _missing("expansion", cfg["label"], mx, "成交额均值为0")
    ratio = short_avg / long_avg
    ret = (closes[-1] / closes[-1 - cfg["short_window"]] - 1.0) * 100.0
    if ret > cfg["flat_return_pct"]:
        direction = "up"
    elif ret < -cfg["flat_return_pct"]:
        direction = "down"
    else:
        direction = "flat"
    score = 0.0
    if direction != "flat":
        table = [t for t in cfg["table"] if t["dir"] == direction]
        table.sort(key=lambda t: -t["ratio_min"])
        for t in table:
            if ratio >= t["ratio_min"]:
                score = float(t["score"])
                break
    reason = "%d日均额/%d日均额 = %.2f，近%d日涨跌 %.1f%%（%s）" % (
        cfg["short_window"], cfg["long_window"], ratio, cfg["short_window"], ret,
        {"up": "放量上涨" if ratio >= 1.0 else "缩量上涨",
         "down": "放量下跌" if ratio >= 1.0 else "缩量下跌",
         "flat": "横盘"}[direction],
    )
    return _item("expansion", cfg["label"], round_score(score), mx, "%.2f×" % ratio, reason)


def score_price_volume(etf: dict, cfg: dict) -> Dict:
    mx = cfg["max"]
    bars = etf.get("bars") or []
    amounts = _amounts(bars)
    closes = _closes(bars)
    w = cfg["window"]
    if len(closes) < w + 1:
        return _missing("price_volume", cfg["label"], mx, "日线不足 %d 根" % (w + 1))
    matches = 0
    considered = 0
    for i in range(len(closes) - w, len(closes)):
        dc = closes[i] - closes[i - 1]
        da = amounts[i] - amounts[i - 1]
        sc = 1 if dc > 0 else (-1 if dc < 0 else 0)
        sa = 1 if da > 0 else (-1 if da < 0 else 0)
        if sc == 0 or sa == 0:
            continue
        considered += 1
        if sc == sa:
            matches += 1
    if considered < cfg["min_samples"]:
        return _missing("price_volume", cfg["label"], mx, "有效样本不足（%d）" % considered)
    ratio = matches / considered
    score = round_score(mx * (2.0 * ratio - 1.0))
    reason = "近%d日量价同向 %d/%d = %.0f%%（%s）" % (
        w, matches, considered, ratio * 100.0,
        "量价配合" if ratio >= 0.5 else "量价背离",
    )
    return _item("price_volume", cfg["label"], score, mx, "%.0f%%" % (ratio * 100), reason)


def score_close_strength(etf: dict, cfg: dict) -> Dict:
    """收盘强度 = 收盘价在当日 [最低,最高] 区间中的位置（近 N 日均值）。

    只依赖 OHLC，不需要成交额，因此在腾讯日线（无成交额字段）下依然有效。
    """
    mx = cfg["max"]
    bars = etf.get("bars") or []
    if len(bars) < cfg["window"]:
        return _missing("close_strength", cfg["label"], mx, "日线不足 %d 根" % cfg["window"])
    positions: List[float] = []
    for b in bars[-cfg["window"]:]:
        high, low, close = float(b["h"]), float(b["l"]), float(b["c"])
        if high > low:
            positions.append((close - low) / (high - low))
        else:
            positions.append(0.5)
    if len(positions) < cfg["min_samples"]:
        return _missing("close_strength", cfg["label"], mx, "有效样本不足")
    mean_pos = _mean(positions)
    score = round_score(mx * (2.0 * mean_pos - 1.0))
    reason = "近%d日收盘位于日内区间 %.0f%% 处（%s）" % (
        len(positions), mean_pos * 100.0,
        "收在偏高位置、尾盘偏强" if mean_pos > 0.55 else ("收在偏低位置、尾盘偏弱" if mean_pos < 0.45 else "居中"),
    )
    return _item("close_strength", cfg["label"], score, mx, "%.0f%%" % (mean_pos * 100.0), reason)


def score_breakout(etf: dict, cfg: dict) -> Dict:
    mx = cfg["max"]
    bars = etf.get("bars") or []
    if len(bars) < cfg["min_samples"]:
        return _missing("breakout", cfg["label"], mx, "日线不足 %d 根" % cfg["min_samples"])
    w = cfg["window"]
    prev = bars[-w - 1 : -1]
    highs = [float(b["h"]) for b in prev]
    lows = [float(b["l"]) for b in prev]
    amounts = _amounts(prev)
    avg_amt = _mean(amounts)
    last = bars[-1]
    last_amt = _amounts([last])[0]
    ok_vol = avg_amt > 0 and last_amt > cfg["ratio_min"] * avg_amt
    score = 0.0
    if float(last["c"]) > max(highs) and ok_vol:
        score = float(cfg["score"])
        reason = "创%d日新高且成交额 %.1f 倍于均额" % (w, last_amt / avg_amt)
    elif float(last["c"]) < min(lows) and ok_vol:
        score = -float(cfg["score"])
        reason = "创%d日新低且成交额 %.1f 倍于均额" % (w, last_amt / avg_amt)
    else:
        reason = "未突破 %d 日区间（%s）" % (
            w, "放量" if ok_vol else "量能不足",
        )
    return _item("breakout", cfg["label"], score, mx,
                 "%.2f×" % (last_amt / avg_amt if avg_amt > 0 else 0.0), reason)


# -------------------------------------------------------------------- 技术
def score_ma(etf: dict, cfg: dict) -> Dict:
    mx = cfg["max"]
    closes = _closes(etf.get("bars") or [])
    if len(closes) < cfg["long"]:
        return _missing("ma", cfg["label"], mx, "日线不足 %d 根" % cfg["long"])
    s = sma(closes, cfg["short"])[-1]
    m = sma(closes, cfg["mid"])[-1]
    l = sma(closes, cfg["long"])[-1]
    if s > m > l:
        score, reason = cfg["full_bull"], "MA%d>MA%d>MA%d 多头排列" % (cfg["short"], cfg["mid"], cfg["long"])
    elif s < m < l:
        score, reason = cfg["full_bear"], "MA%d<MA%d<MA%d 空头排列" % (cfg["short"], cfg["mid"], cfg["long"])
    elif s > m and m < l:
        score, reason = cfg["partial_bull"], "短中期转强、长期均线仍压制"
    else:
        score, reason = cfg["partial_bear"], "短期走弱、长期均线仍上行"
    return _item("ma", cfg["label"], float(score), mx,
                 "%.3f/%.3f/%.3f" % (s, m, l), reason)


def score_macd(etf: dict, cfg: dict) -> Dict:
    mx = cfg["max"]
    closes = _closes(etf.get("bars") or [])
    if len(closes) < cfg["min_samples"]:
        return _missing("macd", cfg["label"], mx, "日线不足 %d 根" % cfg["min_samples"])
    res = macd(closes, cfg["fast"], cfg["slow"], cfg["signal"])
    dif = res["dif"][-1]
    dea = res["dea"][-1]
    hist = res["hist"]
    h_now, h_prev = hist[-1], hist[-2]
    rising = h_now > h_prev
    if dif > dea and rising:
        score, reason = cfg["strong"], "DIF在DEA上方且红柱放大"
    elif dif > dea:
        score, reason = cfg["weak"], "DIF在DEA上方但动能收敛"
    elif dif < dea and rising:
        score, reason = -cfg["weak"], "DIF在DEA下方但绿柱收敛"
    else:
        score, reason = -cfg["strong"], "DIF在DEA下方且绿柱放大"
    return _item("macd", cfg["label"], float(score), mx,
                 "DIF %.3f / DEA %.3f" % (dif, dea), reason)


def score_position(etf: dict, cfg: dict) -> Dict:
    mx = cfg["max"]
    closes = _closes(etf.get("bars") or [])
    if len(closes) < max(cfg["min_samples"], cfg["rsi_window"] + 1):
        return _missing("position", cfg["label"], mx, "日线不足 %d 根" % cfg["min_samples"])
    r = rsi(closes, cfg["rsi_window"])[-1]
    ma = sma(closes, cfg["bias_window"])[-1]
    bias = (closes[-1] - ma) / ma * 100.0 if ma else None
    if r is not None and r < cfg["rsi_oversold"]:
        score, reason = mx, "RSI%.0f 超卖，反弹概率上升" % r
    elif r is not None and r > cfg["rsi_overbought"]:
        score, reason = -mx, "RSI%.0f 超买，追高风险大" % r
    elif bias is not None and abs(bias) > cfg["bias_limit_pct"]:
        score = -mx if bias > 0 else mx
        reason = "%d日乖离率 %.1f%%，偏离过大" % (cfg["bias_window"], bias)
    else:
        score, reason = 0.0, "RSI%.0f、乖离率 %.1f%%，位置中性" % (r or 50.0, bias or 0.0)
    return _item("position", cfg["label"], float(score), mx,
                 "RSI %.0f" % (r or 50.0), reason)


# ------------------------------------------------------------ 汇总与信号灯
def label_of(total: float, rules: dict) -> str:
    if total >= rules["signal"]["bull"]:
        return "偏多"
    if total <= rules["signal"]["bear"]:
        return "偏空"
    return "中性"


def score_dashboard(inp: dict, rules: dict) -> Dict:
    as_of = float(inp.get("asOf") or 0)
    stocks = inp.get("stocks") or []
    futures = inp.get("futures") or {}
    etf = inp.get("etf") or {}
    news = inp.get("news") or []

    fc = rules["fundamental"]
    vc = rules["volume"]
    tc = rules["technical"]

    groups = [
        ("fundamental", "基本面", rules["weights"]["fundamental"], [
            score_cost(futures, fc["cost"]),
            score_valuation(stocks, fc["valuation"]),
            score_breadth(stocks, fc["breadth"]),
            score_news(news, as_of, fc["news"]),
        ]),
        ("volume", "量能", rules["weights"]["volume"], [
            score_expansion(etf, vc["expansion"]),
            score_price_volume(etf, vc["price_volume"]),
            score_close_strength(etf, vc["close_strength"]),
            score_breakout(etf, vc["breakout"]),
        ]),
        ("technical", "技术", rules["weights"]["technical"], [
            score_ma(etf, tc["ma"]),
            score_macd(etf, tc["macd"]),
            score_position(etf, tc["position"]),
        ]),
    ]

    out_groups = []
    weighted = 0.0
    weight_used = 0.0
    missing: List[str] = []
    for key, title, weight, items in groups:
        avail = [it for it in items if not it["missing"]]
        for it in items:
            if it["missing"]:
                missing.append(it["key"])
        have_max = sum(it["max"] for it in avail)
        have_score = sum(it["score"] for it in avail)
        ratio = (have_score / have_max) if have_max > 0 else 0.0
        if have_max > 0:
            weighted += ratio * weight
            weight_used += weight
        out_groups.append({
            "key": key,
            "label": title,
            "weight": weight,
            "score": round1(have_score),
            "max": round1(have_max),
            "ratio": round1(ratio * 100.0),
            "items": items,
        })

    if weight_used <= 0:
        total = 0.0
        label = "数据缺失"
    else:
        total = round1(weighted / weight_used * 100.0)
        label = label_of(total, rules)

    notes = []
    if missing:
        notes.append("部分子项数据缺失（%s），已在维度内按可得项归一" % "、".join(missing))
    if weight_used > 0 and weight_used < sum(rules["weights"].values()):
        notes.append("维度整体缺失，已按剩余维度归一（权重 %.0f/100）" % weight_used)
    if inp.get("dataWarnings"):
        notes.extend(inp["dataWarnings"])

    return {
        "total": total,
        "label": label,
        "strength": round1(abs(total)),
        "components": out_groups,
        "missing": missing,
        "notes": notes,
        "rulesVersion": rules.get("version"),
    }
