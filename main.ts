// Pump.fun paper trading bot for make.fun's "Pump.fun Paper Sprint" bounty.
//
// Strategy (written from my own analysis of the kit's dev replay data):
//   - Watch every new bonding curve from its first trades.
//   - After a coin's 12th trade, enter once when the early flow is buy-dominated
//     (buys are at least 75% of the SOL traded in the first 12 trades), the price
//     has not already run away (at most 1.35x its first-trade price), at least
//     3 distinct buyers showed up, and real SOL reserves are at least 2 SOL
//     (so the 1%-of-reserve size cap still allows a real order).
//   - Size is 0.2 SOL, capped by 1% of the coin's real SOL reserves.
//   - Exit on any of: +50% take-profit, -10% stop-loss, a trailing stop once the
//     price peaked at +25% (sell when it falls back to 85% of the peak), or a
//     30-minute time stop. Sell the whole position.
//   - At most 5 open positions, one entry per mint, ever.
//
// Why this shape: on the dev window, chasing a price that already rose (+20-40%
// in 5 minutes) loses money on average (mean reversion dominates), and the launch
// burst itself is untradable at size because several trades land in the same slot
// before any order can fill. The surviving edge is small and selective: buy the
// coins whose first dozen trades are dominated by real buying, do not chase, and
// get out fast either way. Everything is deterministic: no clock, no environment,
// no unseeded randomness, and all price comparisons are exact bigint ratios.

import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- tuned constants (from the offline sweep on the dev window) -----------------
const EVAL_TRADES = 12; // decide once, when the 12th trade of a coin is seen
const MIN_BUY_SHARE_NUM = 3n; // buys >= 75% of SOL in the first 12 trades
const MIN_BUY_SHARE_DEN = 4n;
const MIN_BUYERS = 3;
const MIN_REAL_SOL_LAMPORTS = 2_000_000_000n;
const MAX_PRICE_VS_FIRST_NUM = 135n; // price <= 1.35x first-trade price
const MAX_PRICE_VS_FIRST_DEN = 100n;
const MIN_PRICE_VS_FIRST_NUM = 70n; // price >= 0.70x first-trade price
const MIN_PRICE_VS_FIRST_DEN = 100n;
const TARGET_BUY_LAMPORTS = 200_000_000n; // 0.2 SOL, before the reserve cap
const MIN_BUY_LAMPORTS = 10_000_000n; // guardrail: round trips of >= 0.01 SOL
const TAKE_PROFIT_NUM = 3n; // +50%
const TAKE_PROFIT_DEN = 2n;
const STOP_LOSS_NUM = 9n; // -10%
const STOP_LOSS_DEN = 10n;
const TRAIL_ARM_NUM = 5n; // trailing stop arms at +25%
const TRAIL_ARM_DEN = 4n;
const TRAIL_NUM = 85n; // sell at 85% of the peak once armed
const TRAIL_DEN = 100n;
const MAX_HOLD_SLOTS = 30 * 280; // ~30 minutes (about 280 slots per minute)
const MAX_SLIPPAGE_BPS = 500;
const MAX_ORDERS_PER_BATCH = 16;

// A price as an exact rational (virtual quote / virtual token), so every
// comparison below is exact integer arithmetic.
interface Price {
  q: bigint;
  t: bigint;
}

interface EarlyFlow {
  trades: number;
  buySol: bigint;
  totalSol: bigint;
  buyers: Set<string>;
  firstPrice: Price | null;
  firstSlot: number;
  decided: boolean;
}

interface Held {
  // Cost basis as an exact rational: cost lamports per token.
  cost: bigint;
  tokens: bigint;
  entrySlot: number;
  peak: Price;
  selling: boolean;
}

// price a >= price b * (num / den), all as exact rationals.
function priceAtLeast(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den >= b.q * a.t * num;
}

// price a <= price b * (num / den).
function priceAtMost(a: Price, b: Price, num: bigint, den: bigint): boolean {
  return a.q * b.t * den <= b.q * a.t * num;
}

function curvePrice(state: BotState, mint: string): Price | null {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return null;
  return { q: c.virtual_quote_reserves, t: c.virtual_token_reserves };
}

const flows = new Map<string, EarlyFlow>();
const held = new Map<string, Held>();

function flowFor(mint: string, slot: number): EarlyFlow {
  let f = flows.get(mint);
  if (f === undefined) {
    f = {
      trades: 0,
      buySol: 0n,
      totalSol: 0n,
      buyers: new Set<string>(),
      firstPrice: null,
      firstSlot: slot,
      decided: false,
    };
    flows.set(mint, f);
  }
  return f;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: Array<{
      side: "buy" | "sell";
      mint: string;
      quote_lamports?: string;
      token_amount?: string;
      max_slippage_bps: number;
    }> = [];

    // Drop held records for positions the harness already closed
    // (curve completed, replay flattened, or a sell filled).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // Sync held records with the account: a newly filled buy shows up as a
    // position we have no record for yet. Its cost basis is cost/tokens.
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        const price = curvePrice(state, mint);
        held.set(mint, {
          cost: BigInt(pos.cost_lamports),
          tokens: BigInt(pos.token_amount),
          entrySlot: state.slot,
          peak: price ?? { q: BigInt(pos.cost_lamports), t: BigInt(pos.token_amount) },
          selling: false,
        });
      }
    }

    // --- exits first: take-profit, stop-loss, trailing stop, time stop. -------
    for (const [mint, h] of held) {
      if (h.selling) continue;
      const price = curvePrice(state, mint);
      if (price === null) continue;
      // Track the peak with the latest reserves.
      if (price.q * h.peak.t > h.peak.q * price.t) h.peak = price;
      const entry: Price = { q: h.cost, t: h.tokens };
      const takeProfit = priceAtLeast(price, entry, TAKE_PROFIT_NUM, TAKE_PROFIT_DEN);
      const stopLoss = priceAtMost(price, entry, STOP_LOSS_NUM, STOP_LOSS_DEN);
      const trailing =
        priceAtLeast(h.peak, entry, TRAIL_ARM_NUM, TRAIL_ARM_DEN) &&
        priceAtMost(price, h.peak, TRAIL_NUM, TRAIL_DEN);
      const timedOut = state.slot - h.entrySlot > MAX_HOLD_SLOTS;
      // Never sell into a completed curve: the harness rejects it.
      const curve = state.curves.get(mint);
      if (curve !== undefined && curve.complete) continue;
      // Do not double-sell while a sell is still in flight.
      let pendingSell = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === "sell") {
          pendingSell = true;
          break;
        }
      }
      if (pendingSell) continue;
      if (takeProfit || stopLoss || trailing || timedOut) {
        const live = state.positions.get(mint);
        if (live === undefined) continue;
        orders.push({
          side: "sell",
          mint,
          token_amount: live.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        h.selling = true;
      }
    }

    // --- entries: watch this batch's events in chain order. -------------------
    for (const event of batch.events) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (event.event === "CompleteEvent") {
        flows.delete(event.mint);
        continue;
      }
      if (event.event !== "TradeEvent") continue;
      const mint = event.mint;
      if (held.has(mint) || flows.get(mint)?.decided) continue;
      const f = flowFor(mint, event.slot);
      if (f.decided) continue;
      const price: Price = {
        q: BigInt(event.virtual_sol_reserves),
        t: BigInt(event.virtual_token_reserves),
      };
      if (f.firstPrice === null) f.firstPrice = price;
      f.trades += 1;
      const amount = BigInt(event.sol_amount);
      f.totalSol += amount;
      if (event.is_buy) {
        f.buySol += amount;
        f.buyers.add(event.user);
      }
      if (f.trades !== EVAL_TRADES) continue;
      f.decided = true;
      // One entry per mint, ever; the decision is made exactly here.
      if (held.has(mint)) continue;
      if (f.firstPrice === null) continue;
      if (f.buySol * MIN_BUY_SHARE_DEN < f.totalSol * MIN_BUY_SHARE_NUM) continue;
      if (f.buyers.size < MIN_BUYERS) continue;
      if (!priceAtMost(price, f.firstPrice, MAX_PRICE_VS_FIRST_NUM, MAX_PRICE_VS_FIRST_DEN)) continue;
      if (!priceAtLeast(price, f.firstPrice, MIN_PRICE_VS_FIRST_NUM, MIN_PRICE_VS_FIRST_DEN)) continue;
      const realSol = BigInt(event.real_sol_reserves);
      if (realSol < MIN_REAL_SOL_LAMPORTS) continue;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === "buy") {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) continue;
      // Size: 0.2 SOL, capped by 1% of real reserves at decision time.
      const cap = state.maxBuyLamports(mint);
      let size = TARGET_BUY_LAMPORTS;
      if (cap < size) size = cap;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    return orders;
  },
});
