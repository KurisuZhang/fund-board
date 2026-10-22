"""技术指标计算（纯函数，无网络、无 pandas 依赖）。

与 assets/indicators.js 逐行对应；两端运算顺序一致，以保证打分结果一致。
所有函数对"数据不足"一律返回 None / None 元素，不抛异常。
"""
from __future__ import annotations

from typing import List, Optional, Sequence


def _clean(values: Sequence[Optional[float]]) -> List[Optional[float]]:
    return [None if v is None else float(v) for v in values]


def sma(values: Sequence[Optional[float]], window: int) -> List[Optional[float]]:
    """简单移动平均，前 window-1 个为 None；窗口内出现 None 则该点为 None。"""
    vals = _clean(values)
    out: List[Optional[float]] = []
    n = len(vals)
    for i in range(n):
        if i + 1 < window:
            out.append(None)
            continue
        chunk = vals[i + 1 - window : i + 1]
        if any(v is None for v in chunk):
            out.append(None)
            continue
        out.append(sum(chunk) / window)  # type: ignore[arg-type]
    return out


def ema(values: Sequence[Optional[float]], window: int) -> List[Optional[float]]:
    vals = _clean(values)
    out: List[Optional[float]] = []
    k = 2.0 / (window + 1.0)
    prev: Optional[float] = None
    for v in vals:
        if v is None:
            out.append(prev)
            continue
        prev = v if prev is None else v * k + prev * (1.0 - k)
        out.append(prev)
    return out


def macd(
    closes: Sequence[Optional[float]], fast: int = 12, slow: int = 26, signal: int = 9
) -> dict:
    """返回 {dif, dea, hist}；hist = (dif - dea) * 2（国内常用口径）。"""
    fast_e = ema(closes, fast)
    slow_e = ema(closes, slow)
    dif: List[Optional[float]] = []
    for f, s in zip(fast_e, slow_e):
        dif.append(None if (f is None or s is None) else f - s)
    dea = ema(dif, signal)
    hist: List[Optional[float]] = []
    for d, e in zip(dif, dea):
        hist.append(None if (d is None or e is None) else (d - e) * 2.0)
    return {"dif": dif, "dea": dea, "hist": hist}


def rsi(closes: Sequence[Optional[float]], window: int = 14) -> List[Optional[float]]:
    """简单均值口径 RSI（非 Wilder 平滑），便于两端严格对齐。"""
    vals = _clean(closes)
    out: List[Optional[float]] = [None] * len(vals)
    for i in range(window, len(vals)):
        gains = 0.0
        losses = 0.0
        ok = True
        for j in range(i - window + 1, i + 1):
            a, b = vals[j - 1], vals[j]
            if a is None or b is None:
                ok = False
                break
            diff = b - a
            if diff >= 0:
                gains += diff
            else:
                losses -= diff
        if not ok:
            continue
        avg_gain = gains / window
        avg_loss = losses / window
        if avg_loss == 0:
            out[i] = 100.0 if avg_gain > 0 else 50.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100.0 - 100.0 / (1.0 + rs)
    return out


def percentile_rank(values: Sequence[Optional[float]], window: int) -> Optional[float]:
    """最新值在最近 window 个值中的分位（0-100），口径：(<=当前值的个数)/window*100。"""
    vals = [v for v in _clean(values) if v is not None]
    if len(vals) < window or window <= 0:
        return None
    chunk = vals[-window:]
    cur = chunk[-1]
    cnt = sum(1 for v in chunk if v <= cur)
    return cnt / window * 100.0


def pct_change(closes: Sequence[Optional[float]], window: int) -> Optional[float]:
    """window 根 K 线的涨跌幅（%）。"""
    vals = [v for v in _clean(closes) if v is not None]
    if len(vals) < window + 1 or vals[-1 - window] == 0:
        return None
    return (vals[-1] / vals[-1 - window] - 1.0) * 100.0


LIMIT = 1000000000.0


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else (hi if x > hi else x)


def round_score(x: float) -> float:
    """四舍五入（.5 向 +∞），与 JS 的 Math.floor(x + 0.5) 完全一致。"""
    import math

    return float(math.floor(x + 0.5))


def round1(x: float) -> float:
    import math

    return math.floor(x * 10.0 + 0.5) / 10.0


def pick_by_max(buckets: Sequence[dict], value: float) -> Optional[dict]:
    """按 max 升序取第一个 value <= max 的档位。"""
    for b in buckets:
        if value <= b["max"]:
            return b
    return None


def pick_by_min(buckets: Sequence[dict], value: float) -> Optional[dict]:
    """按 min 降序取第一个 value >= min 的档位。"""
    ordered = sorted(buckets, key=lambda b: -b["min"])
    for b in ordered:
        if value >= b["min"]:
            return b
    return None
