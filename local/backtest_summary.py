"""逐日打分 → 未来 N 日收益 → 按得分分桶统计胜率，生成静态快照。

用法：
    python3 local/backtest_summary.py                       # 写入 assets/fixtures/backtest_summary.json
    python3 local/backtest_summary.py --out /tmp/x.json --hold 5

页面用它回答「历史上一出现类似得分，后面 5 天涨的概率是多少」。
只覆盖价格类因子（上游期货 / 量能 / 技术），估值与新闻无法回溯，已在 note 中说明。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, List

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, "local"))

import datafeed  # noqa: E402
import scoring  # noqa: E402

RULES_PATH = os.path.join(BASE_DIR, "shared", "scoring_rules.json")
DEFAULT_OUT = os.path.join(BASE_DIR, "assets", "fixtures", "backtest_summary.json")
WARMUP = 65


def _bars_until(bars: List[dict], date: str) -> List[dict]:
    out = []
    for b in bars:
        if b["d"] <= date:
            out.append(b)
        else:
            break
    return out


def daily_totals(etf_bars: List[dict], futures_bars: List[dict], rules: dict) -> List[dict]:
    """逐日打分（只用当日及以前的可得数据），返回 [{d, total}]。"""
    out = []
    for i in range(WARMUP, len(etf_bars)):
        date = etf_bars[i]["d"]
        sub_etf = etf_bars[: i + 1]
        sub_fut = _bars_until(futures_bars, date)
        if len(sub_fut) < WARMUP:
            continue
        inp = {
            "etf": {"bars": sub_etf, "price": sub_etf[-1]["c"]},
            "futures": {"bars": sub_fut, "close": sub_fut[-1]["c"]},
            "stocks": [], "news": [], "index": {"bars": []}, "bench": {"bars": []},
        }
        score = scoring.score_dashboard(inp, rules)
        out.append({"d": date, "total": score.get("total") or 0.0})
    return out


def signal_dates(totals: List[dict], bull: float) -> List[str]:
    """得分由「低于阈值」翻到「达到阈值」的那一天（与回测事件定义一致）。"""
    out, prev = [], None
    for row in totals:
        is_bull = row["total"] >= bull
        if prev is False and is_bull:
            out.append(row["d"])
        prev = is_bull
    return out


def bucket_stats(pairs: List[tuple], bucket_width: int) -> List[dict]:
    """[(得分, 未来收益%)] → 分桶统计；桶号向下取整（-13 落在 -20~-10）。"""
    buckets: Dict[int, List[float]] = {}
    for total, fwd in pairs:
        key = int(total // bucket_width) * bucket_width
        buckets.setdefault(key, []).append(fwd)
    out = []
    for key in sorted(buckets):
        vals = sorted(buckets[key])
        n = len(vals)
        wins = len([v for v in vals if v > 0])
        out.append({
            "bucket": key,
            "label": "%d~%d" % (key, key + bucket_width),
            "samples": n,
            "winRate": round(wins / n * 100.0, 1) if n else None,
            "avgReturn": round(sum(vals) / n, 2) if n else None,
            "medianReturn": round(vals[n // 2], 2) if n else None,
        })
    return out


def build_summary(rules: dict, hold: int = 5, bucket_width: int = 10,
                  min_samples: int = 8, feed: "datafeed.DataFeed | None" = None) -> dict:
    feed = feed or datafeed.DataFeed(rules)
    inst = rules["instruments"]
    fetch = rules.get("fetch", {})
    etf_bars = feed.stock_kline(inst["etf"]["code"], fetch.get("etf_days", 320))
    futures_bars = feed.futures_kline(inst["futures"]["symbol"])

    totals = daily_totals(etf_bars, futures_bars, rules)
    bars_by_date = {b["d"]: i for i, b in enumerate(etf_bars)}

    pairs = []
    for row in totals:
        idx = bars_by_date.get(row["d"])
        if idx is None or idx + hold >= len(etf_bars):
            continue
        entry, exit_ = etf_bars[idx]["c"], etf_bars[idx + hold]["c"]
        if not entry:
            continue
        pairs.append((row["total"], (exit_ / entry - 1.0) * 100.0))
    stats = bucket_stats(pairs, bucket_width)

    bull = float((rules.get("signal") or {}).get("bull", 25))
    return {
        "generatedAt": time.strftime("%Y-%m-%d", time.localtime()),
        "rangeStart": totals[0]["d"] if totals else None,
        "rangeEnd": totals[-1]["d"] if totals else None,
        "hold": hold,
        "bucketWidth": bucket_width,
        "minSamples": min_samples,
        "buckets": stats,
        "signalDates": signal_dates(totals, bull)[-60:],
        "note": "仅价格类因子（期货/量能/技术）；估值与新闻不可回溯，故与完整打分体系不完全等价。",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="生成历史胜率分桶快照")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--hold", type=int, default=5)
    ap.add_argument("--bucket-width", type=int, default=10)
    args = ap.parse_args()

    with open(RULES_PATH, encoding="utf-8") as f:
        rules = json.load(f)
    data = build_summary(rules, hold=args.hold, bucket_width=args.bucket_width)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    total = sum(b["samples"] for b in data["buckets"])
    print("已生成 %s（%d 个分桶 / %d 个样本 / %s ~ %s）"
          % (args.out, len(data["buckets"]), total, data["rangeStart"], data["rangeEnd"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
