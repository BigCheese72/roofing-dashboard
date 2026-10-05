# MNQ ORB — Opening-Range Window Length Backtest (15 vs 30 vs 60 min)

**Question:** Would shortening the opening range help Mark's RTH ORB (so he could act earlier)?
**Data:** mnq_1m.parquet — 2,480,618 one-minute MNQ bars, US/Eastern, May 2019–Jun 2026.
**Rules tested (his ORB, only the OR window varied):** RTH open 9:30 ET; OR = high/low of the window; breakout entry 1 tick beyond OR high (long) / low (short) on first break after lock; stop = 80-pt cap; target = 3R; one trade/day; flat by 16:00 ET. Costs = $2.24 round-trip/micro ($0.62/side + 1 tick slippage); $2/point; 1 micro.

## Results (full history)

| OR window | Trades | Win% | Profit Factor | Net (1 micro) | Avg/trade | Max DD |
|---|---|---|---|---|---|---|
| 15-min | 1,800 | 41.2% | 1.06 | +$8,739 | +$4.85 | −$4,241 |
| 30-min | 1,790 | 42.7% | 1.08 | +$10,811 | +$6.04 | −$3,079 |
| **60-min (current)** | **1,733** | **46.8%** | **1.18** | **+$20,325** | **+$11.73** | −$3,956 |

## Verdict
**Keep the 60-minute range.** Shortening it degrades the edge: 30-min ~halves net and drops PF 1.18→1.08; 15-min is worse. The longer window yields a cleaner high/low; shorter windows trade noise. The earlier-timing benefit of a shorter range is NOT worth the lost edge. The real improvement is DELIVERY timing — get the existing 60-min plan to Mark right at the 10:30 ET lock instead of ~12 min late — not a shorter range.

## Caveats
Simplified sim: conservative "stop-first" on bars that touch both stop & target same bar; both-sides-break days resolved by nearest-to-bar-open; no explicit half-day filter. Directionally robust. Not financial advice; past performance ≠ future results.
