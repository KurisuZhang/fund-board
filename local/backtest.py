"""历史验证：把打分规则套到历史每一天，检验"信号翻多之后"的真实表现。

口径（与页面一致，务必如实告知）：
  * 只用历史可得的因子：碳酸锂期货（cost）、量能（volume 全部）、技术（technical 全部）。
  * 估值（PE 快照）与新闻情绪无法回溯，因此不参与回测；缺失子项由打分引擎自动归一。
  * 事件定义：综合得分由「未达到偏多阈值」转为「达到偏多阈值」的那一天。
  * 前向收益：事件日收盘买入，持有 N 个交易日后收盘卖出；同时给出相对沪深300的超额。
"""
from __future__ import annotations

from typing import Dict, List

import scoring


def _bars_until(bars: List[dict], date: str) -> List[dict]:
    out = []
    for b in bars:
        if b["d"] <= date:
            out.append(b)
        else:
            break
    return out


def run_backtest(etf_bars: List[dict], futures_bars: List[dict], bench_bars: List[dict],
                 rules: dict, hold: int = 5) -> Dict:
    hold = max(1, min(int(hold), 20))
    bull = rules["signal"]["bull"]
    warmup = 65
    events: List[dict] = []
    prev_label_bull = None

    bench_map = {b["d"]: b["c"] for b in bench_bars}
    bench_dates = [b["d"] for b in bench_bars]

    max_i = len(etf_bars) - 1
    for i in range(warmup, max_i + 1):
        date = etf_bars[i]["d"]
        sub_etf = etf_bars[: i + 1]
        sub_fut = _bars_until(futures_bars, date)
        if len(sub_fut) < 65:
            continue
        inp = {
            "etf": {"bars": sub_etf, "price": sub_etf[-1]["c"]},
            "futures": {"bars": sub_fut, "close": sub_fut[-1]["c"]},
            "stocks": [],
            "news": [],
            "asOf": 0,
            "index": {"bars": []},
            "bench": {"bars": []},
        }
        out = scoring.score_dashboard(inp, rules)
        is_bull = out["total"] >= bull
        if prev_label_bull is None:
            prev_label_bull = is_bull
            continue
        if is_bull and not prev_label_bull:
            entry_price = etf_bars[i]["c"]
            entry_date = date
            exit_idx = min(i + hold, max_i)
            exit_price = etf_bars[exit_idx]["c"]
            fwd = None
            excess = None
            if exit_idx > i:
                fwd = (exit_price / entry_price - 1.0) * 100.0
                bench_entry = _bench_at(bench_map, bench_dates, entry_date)
                bench_exit = _bench_at(bench_map, bench_dates, etf_bars[exit_idx]["d"])
                if bench_entry and bench_exit:
                    excess = fwd - (bench_exit / bench_entry - 1.0) * 100.0
            events.append({
                "date": entry_date,
                "score": out["total"],
                "entry": round(entry_price, 4),
                "exitDate": etf_bars[exit_idx]["d"],
                "exit": round(exit_price, 4),
                "fwd": None if fwd is None else round(fwd, 2),
                "excess": None if excess is None else round(excess, 2),
            })
        prev_label_bull = is_bull

    closed = [e for e in events if e["fwd"] is not None]
    wins = [e for e in closed if e["fwd"] > 0]
    stats = {
        "hold": hold,
        "signalCount": len(events),
        "closedCount": len(closed),
        "winRate": round(len(wins) / len(closed) * 100.0, 1) if closed else None,
        "avgReturn": round(sum(e["fwd"] for e in closed) / len(closed), 2) if closed else None,
        "medianReturn": round(sorted(e["fwd"] for e in closed)[len(closed) // 2], 2) if closed else None,
        "avgExcess": round(_avg([e["excess"] for e in closed]), 2) if closed else None,
        "best": max((e["fwd"] for e in closed), default=None),
        "worst": min((e["fwd"] for e in closed), default=None),
        "sampleEnough": len(closed) >= 20,
    }

    # 策略净值：事件日买入、持有 hold 天后卖出（重叠区间允许并存，按等权占用）
    equity = _strategy_equity(etf_bars, closed, hold, warmup)
    buyhold = _buyhold_equity(etf_bars, warmup)
    return {"stats": stats, "events": events, "equity": equity, "buyhold": buyhold,
            "note": "回测仅覆盖价格类因子（上游期货/量能/技术）；估值与新闻无法回溯，已按规则自动归一。"}


def _avg(values: List) -> float:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else 0.0


def _bench_at(bench_map: dict, bench_dates: List[str], date: str):
    """取 <= date 的最近一个基准收盘价。"""
    best = None
    for d in bench_dates:
        if d <= date:
            best = bench_map[d]
        else:
            break
    return best


def _buyhold_equity(etf_bars: List[dict], start: int) -> List[dict]:
    base = etf_bars[start]["c"]
    return [{"d": b["d"], "v": round((b["c"] / base - 1.0) * 100.0, 2)}
            for b in etf_bars[start:]]


def _strategy_equity(etf_bars: List[dict], events: List[dict], hold: int, start: int) -> List[dict]:
    """信号择时净值：只在信号持有期内满仓 ETF，其余时间空仓，逐日复利。

    与「买入持有」同一坐标系，便于直接比较两条曲线谁更赚钱。
    """
    idx_by_date = {b["d"]: i for i, b in enumerate(etf_bars)}
    n = len(etf_bars)
    active = [0] * n
    for ev in events:
        ei = idx_by_date.get(ev["date"])
        if ei is None:
            continue
        for i in range(ei, min(ei + hold, n - 1) + 1):
            active[i] = 1

    curve = 1.0
    out = []
    for i in range(start, n):
        if active[i] and i > 0 and etf_bars[i - 1]["c"]:
            curve *= etf_bars[i]["c"] / etf_bars[i - 1]["c"]
        out.append({"d": etf_bars[i]["d"], "v": round((curve - 1.0) * 100.0, 2),
                    "active": active[i]})
    return out
