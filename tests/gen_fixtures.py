"""生成两端共用的固定输入样本与 Python 侧期望结果。

python3 tests/gen_fixtures.py          写入 tests/fixtures/sample_input.json 与 assets/fixtures/golden.json
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "local"))

import scoring  # noqa: E402


class LCG:
    """确定性伪随机（同一序列在 Python/JS 之外无需复现，样本已落盘 JSON）。"""

    def __init__(self, seed=20261022):
        self.s = seed

    def next(self):
        self.s = (self.s * 1103515245 + 12345) % (2 ** 31)
        return self.s / float(2 ** 31)


def make_bars(rng, n, start, drift, vol_pct, base_amount):
    bars = []
    price = start
    for i in range(n):
        price = price * (1.0 + drift + (rng.next() - 0.5) * vol_pct)
        amount_factor = 1.0 + (rng.next() - 0.5) * 0.8
        volume = base_amount * amount_factor / price / 100.0
        amount = volume * 100.0 * price * (1.0 + (rng.next() - 0.5) * 0.004)
        high = price * (1.0 + rng.next() * 0.012)
        low = price * (1.0 - rng.next() * 0.012)
        bars.append({
            "d": "2025-%02d-%02d" % (i // 28 % 12 + 1, i % 28 + 1),
            "o": round(price * (1.0 + (rng.next() - 0.5) * 0.004), 4),
            "h": round(high, 4), "l": round(low, 4),
            "c": round(price, 4),
            "v": round(volume, 2), "a": round(amount, 2),
        })
    return bars


def build_sample():
    rng = LCG()
    as_of = 1792678000.0  # 2026-10-22 附近固定时刻
    etf_bars = make_bars(rng, 320, 0.72, -0.0008, 0.02, 3.0e8)
    futures_bars = make_bars(rng, 400, 105000.0, -0.0004, 0.018, 1.0e10)
    bench_bars = make_bars(rng, 320, 3900.0, 0.0002, 0.008, 4.0e11)

    stocks = []
    pes = [12.0, 15.5, 61.0, -8.0, 19.0, 34.0, 27.0, None, 41.0, 13.0, 22.0, 150.0,
           80.0, 11.0, 29.0, 18.5, -102.0, 26.0, 33.0, 24.0, 28.0, -72.0, 20.0]
    caps = [10000.0, 900.0, 1400.0, 90.0, 860.0, 190.0, 195.0, 130.0, 7300.0, 528.0,
            418.0, 408.0, 181.0, 744.0, 598.0, 241.0, 58.0, 116.0, 185.0, 232.0,
            251.0, 69.0, 105.0]
    for i, (pe, cap) in enumerate(zip(pes, caps)):
        n_bars = 120 if i % 7 != 3 else 12  # 少数个股日线不足，触发广度分母变化
        drift = -0.0012 if i % 3 != 0 else 0.0011
        stocks.append({
            "code": "sz%06d" % (300000 + i * 7),
            "name": "样本%d" % i,
            "price": 20.0 + i,
            "pe": pe,
            "marketCap": cap,
            "bars": make_bars(rng, n_bars, 20.0 + i, drift, 0.022, 1.5e8),
        })

    titles = [
        "储能招标规模超预期，多家电池厂中标",
        "碳酸锂价格上涨，储能电芯成本抬升",
        "储能电池价格战延续，二三线厂商亏损",
        "某省新型储能装机开工，政策支持加码",
        "储能项目招标延期，交付节奏放缓",
        "头部企业扩产储能电芯，订单饱满",
        "海外储能需求放量，出海订单签约",
        "储能产能过剩担忧升温，行业降价",
        "机构上调储能板块评级，看好需求",
        "储能电站并网加速，装机超预期",
        "部分储能项目取消，业主下调规模",
        "碳酸锂库存高企，价格承压降价",
        "储能电池出口数据下滑，需求萎缩",
        "政策支持储能参与现货市场",
        "某公司储能业务亏损，计提减值",
    ]
    news = []
    for i in range(30):
        news.append({
            "ts": as_of - (i * 1.6 + 0.5) * 3600.0,
            "title": titles[i % len(titles)],
        })

    return {
        "etf": {"price": etf_bars[-1]["c"], "prevClose": etf_bars[-2]["c"], "changePct": -1.87,
                "bars": etf_bars},
        "index": {"bars": etf_bars},
        "bench": {"bars": bench_bars},
        "futures": {"bars": futures_bars, "close": futures_bars[-1]["c"]},
        "stocks": stocks,
        "news": news,
        "asOf": as_of,
        "dataWarnings": [],
    }


def main():
    with open(os.path.join(ROOT, "shared", "scoring_rules.json"), encoding="utf-8") as f:
        rules = json.load(f)
    sample = build_sample()
    pytest_dir = os.path.join(ROOT, "tests", "fixtures")
    os.makedirs(pytest_dir, exist_ok=True)
    asset_dir = os.path.join(ROOT, "assets", "fixtures")
    os.makedirs(asset_dir, exist_ok=True)

    with open(os.path.join(pytest_dir, "sample_input.json"), "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(pytest_dir, "rules.json"), "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, separators=(",", ":"))
    # 浏览器自检页需要同一份输入样本
    with open(os.path.join(asset_dir, "sample_input.json"), "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, separators=(",", ":"))

    golden = scoring.score_dashboard(sample, rules)
    with open(os.path.join(asset_dir, "golden.json"), "w", encoding="utf-8") as f:
        json.dump(golden, f, ensure_ascii=False, indent=2)

    print("total=%s label=%s" % (golden["total"], golden["label"]))
    for g in golden["components"]:
        print("  %-12s %6.1f / %5.1f  (%.0f%%)" % (g["label"], g["score"], g["max"], g["ratio"]))
        for it in g["items"]:
            print("      %-14s %5.1f/%2.0f  %s" % (it["key"], it["score"], it["max"], it["reason"][:60]))


if __name__ == "__main__":
    main()
