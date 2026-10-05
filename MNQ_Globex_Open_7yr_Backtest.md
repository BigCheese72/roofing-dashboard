# MNQ Globex-Open Strategy — Full 7-Year Backtest

**Data:** your `mnq_1m.parquet` — 2,480,618 one-minute MNQ bars, **May 2019 → June 2026** (~7 years). Stamps are US/Eastern (daily maintenance break sits at 17:00 ET, reopen 18:00 ET = **17:00 CT**). Backtested in Python/pandas on the raw 1-minute path, weeknight (Mon–Thu evening) 17:00 CT reopens, Sunday weekly reopen excluded. Costs modeled: $0.62/side commission + 1 tick slippage ≈ **$2.24 round-trip per micro**. 1 MNQ contract, $2/point.

---

## Headline finding

**The 9-month TradingView "short-fade winner" was a regime artifact. It does not survive 7 years — it's a loser on the full data.**

Over the full history, a parameter sweep (fade vs breakout, short vs long, OR windows 15/30/60 min, stops 1×/1.5×) shows:

- **Every SHORT variant loses** (PF 0.82–0.92). The short-fade that looked good on 2026's up-grind is net **negative** across 2019–2026.
- **Every BREAKOUT variant loses** (PF 0.82–0.96) — the open mean-reverts, so trading *with* the opening-range break bleeds out. This part the small sample got right.
- **The one side with a durable, positive tendency is the opposite of the small-sample winner: fade the DOWNSIDE break and buy back toward the open (long).**

## The one setup that holds up

**FADE-LONG, 30-min opening range:** when a 30-min bar **closes below the OR low** (18:00–18:30 ET range), **buy** at that close; **stop** = OR low − 1× OR range; **target** = the session open (18:00 price); time-stop end of the ~5h window. Weeknights only, skip Sunday.

| Metric | Value |
|---|---|
| Trades | 840 |
| Win rate | 52% |
| Net (1 micro) | **+$2,127** |
| Profit factor | **1.16** |
| Avg per trade | **+$2.53** |
| Max drawdown | −$939 |

**Per-year (profitable in 7 of 8 years):**

| Year | Trades | Net $ | PF |
|---|---|---|---|
| 2019 | 72 | +111 | 1.20 |
| 2020 | 131 | +573 | 1.27 |
| 2021 | 128 | +144 | 1.09 |
| 2022 | 128 | +591 | 1.30 |
| 2023 | 111 | +20 | 1.02 |
| 2024 | 97 | −251 | 0.85 |
| 2025 | 120 | +635 | 1.25 |
| 2026 (part) | 53 | +304 | 1.15 |

## Honest read

This is a **real but thin** edge, not a money machine. Average profit is **+$2.53/trade against ~$2.24 of cost** — most of the gross edge is eaten by commissions/slippage, so it only works with clean fills and low costs. It's positive in 7 of 8 years (2024 was a small loss), which is more convincing than the 9-month sample, but the R-multiple matters: widen the stop to 1.5× and the edge disappears. Scaling to more contracts scales the (small) edge and the drawdown together.

**What the data actually says about the Globex open:** it has a mild **mean-reversion** character — breaks of the opening range tend to get faded back toward the open, and the *long* side of that (buying downside flushes) is where the small positive expectancy lives. Breakouts and short-fades don't pay.

Not financial advice; no orders were placed. This is decision-support — your call whether a ~1.16 PF, cost-sensitive edge is worth trading, tightening (session/volatility filters), or passing on.

## Files
- Equity curve: `mnq_globex_fadelong_equity.png`
- All 840 trades: `mnq_globex_fadelong_trades.csv`
