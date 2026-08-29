# ursella-fifo-engine

A deterministic **FIFO inventory + COGS / gross-margin engine** for Ursella.

Pure TypeScript. **Zero dependencies. No database, no network, no keys.** You
feed it plain data (built from your own rows), it returns cost of goods sold per
sale, gross margin, and current inventory value. It is the accurate financial
core that your P&L reports and the AI "co-pilot" can build on.

## Why this exists

Getting COGS right is deceptively hard: costs change between deliveries, sales
consume stock in a particular order, returns come back, stock gets written off,
and floating-point money math quietly drifts. This module does that one job
correctly and predictably, so everything downstream (margins, P&L, "what should
I restock?") is trustworthy.

## What it guarantees

- **Credential-free.** It operates on data *shapes*, never on your live systems.
  Nothing here connects to Supabase or reads secrets. You stay in control of your data.
- **Deterministic.** Events are processed in a fixed order (timestamp, then
  `sequence`, then input order), so the same inputs always give the same numbers.
- **Zero dependencies.** Nothing to `npm install`. Tests use only Node built-ins.
- **Tested.** Ten unit tests cover the tricky cases (see `tests/`).

## The data contract

You provide three lists (from your three tables). The engine turns them into a
single, time-ordered stream of **events**:

| Your table | Becomes | Meaning |
|---|---|---|
| `products` | `Product` | catalog: `id`, `name`, optional `sku` / `unit` / `currency` |
| `stock_movements` | `receipt` / `return` / `adjustment` | stock in/out that isn't a sale |
| `sale_line_items` | `sale` | a sold line: consumes stock, earns revenue |

Event kinds:

- **receipt** — stock bought in at a `unitCost`; creates a FIFO cost lot.
- **sale** — consumes lots oldest-first; yields `cogs`, `revenue`, `grossMargin`.
- **return** — customer goods back on the shelf; restocked at a cost basis.
- **adjustment** — manual correction: `+qty` adds stock (needs `unitCost`),
  `-qty` writes it off (shrinkage/damage).

Exact field names and types are in [`src/types.ts`](src/types.ts).

## How the FIFO costing works

Each receipt becomes a **cost lot** (a quantity at a unit cost). A sale walks the
lots **oldest first**, taking units until the sale quantity is met — possibly
spanning several lots at different costs. COGS is the sum of what it took; gross
margin is `revenue − COGS`. Inventory value at any point is the sum of what's
left in the open lots.

## Edge cases handled

- **Partial lots** — a sale spanning two price levels is split correctly.
- **Insufficient stock** — by default the sale is still recorded, only the
  covered units are costed, and the rest is reported as `shortfallQuantity`
  (nothing is silently invented). Optional `backorder` mode costs the overage
  at a fallback price.
- **Returns** — restocked at last-consumed cost by default (configurable).
- **Shrinkage / write-offs** — negative adjustments consume lots.
- **Out-of-order input** — events are sorted by time before processing.
- **Money rounding** — half-up, corrected for floating-point drift.

## Quick start

Requires Node **22.6+** (runs the TypeScript directly — nothing to build).

```sh
npm test     # runs the unit tests (node --test)
npm run demo # runs a sample store and prints COGS / margins / valuation
```

## Using it in Ursella

1. Open [`src/adapter.ts`](src/adapter.ts) and edit the three mapping functions
   so they match **your** Supabase column names. That's the only file you touch.
2. Read your rows however you already do (Supabase client, an Edge Function, an
   export — your call; the engine doesn't care).
3. Build the events and run the ledger:

```ts
import { runLedger } from "./src/engine.ts";
import { buildInput, exampleSupabaseAdapter } from "./src/adapter.ts";

// swap exampleSupabaseAdapter for your edited adapter, and pass your rows:
const { events } = buildInput(myAdapter, { products, stockMovements, saleLineItems });
const result = runLedger(events, { roundingDecimals: 2 });

result.sales;             // COGS + margin per sale line
result.totals;            // revenue, cogs, grossMargin, inventoryValue...
result.valuationByProduct;// quantity on hand + value per product
result.warnings;          // insufficient-stock / missing-cost notices
```

## Options

```ts
runLedger(events, {
  roundingDecimals: 2,              // money precision
  insufficientStock: "shortfall",   // or "backorder"
  fallbackUnitCost: "lastKnown",    // or "zero" | a number (backorder only)
  returnRestockCost: "lastConsumed" // or "averageOnHand" | "explicit"
});
```

## Your schema — fully wired

Mapped to your actual tables: **`products`**, **`inventory_transactions`**, and
**`sale_items`** (`src/ursella-adapter.ts`). Two things in that schema needed
handling, and both are worth knowing about:

### 1. `inventory_transactions` has no cost column

It records *how many* units moved, never *what they cost*. FIFO needs a cost per
stock-in — otherwise there's no way to know the 20 bags received in January cost
30 and the 20 received in March cost 34.

Until that's fixed, the adapter falls back to `products.cost_price` (pass
`productCostIndex(products)`), which is a single current cost applied to every
past receipt — better than nothing, still an approximation.

**The real fix** is one additive, nullable column:
[`migrations/001_add_unit_cost.sql`](migrations/001_add_unit_cost.sql). Nothing
is rewritten, existing inserts keep working, and the engine already prefers
`unit_cost` when present and falls back when it's NULL — so you can adopt it
gradually. Once stock-ins write a `unit_cost`, FIFO is exact.

### 2. `sale_items.product_id` is nullable

Deleted products leave a row with only `product_name_snapshot`. Those can't be
costed against stock, so they're **skipped and reported** in `adapter.issues`
rather than silently dropped.

### Revenue respects discounts

`sale_items` carries `unit_price`, `discount`, `subtotal` and `total`. Revenue
defaults to **`total`** (already net of discount), so margin reflects what the
customer actually paid, not the list price. Override with
`revenueBasis: "subtotal" | "unit_price"`.

### You already snapshot cost — this measures how far off it is

`sale_items.unit_cost` is your current COGS approach: cost frozen at sale time.
That's reasonable until supplier prices move, at which point margins drift.
`compareToRecordedCost()` puts a number on that drift — recorded vs. true FIFO,
per line and in total. Useful for deciding whether this matters for your stores
before you change anything.

### Other schema details handled

- Postgres `numeric` arrives as a **string** via supabase-js — parsed everywhere.
- `transaction_type` is a pg enum whose labels weren't supplied, so classification
  is loose (`purchase` / `receipt` / `stock_in` all mean stock in). Override
  exactly via `transactionTypeMap` if your labels differ.
- Rows mirroring a sale in `inventory_transactions` are **skipped**, so stock
  isn't consumed twice (once by the transaction, once by the sale item).
- `forBusiness()` filters to one tenant before costing.

## Migration path



[`src/ursella-adapter.ts`](src/ursella-adapter.ts) is mapped to your **actual
`products` table** (uuid ids, `business_id`, `cost_price`/`selling_price`,
`stock_quantity`). It handles the details that bite in production:

- Postgres `numeric` arrives as a **string** via supabase-js — parsed via `num()`.
- `movement_type` naming is matched loosely (`purchase` / `receipt` / `stock_in`
  all count as stock in), so it works whatever you called them.
- Rows that mirror a sale in `stock_movements` are **skipped**, so stock isn't
  consumed twice (once by the movement, once by the sale line).
- `forBusiness()` filters to one tenant before costing.

### One thing worth knowing

`products.stock_quantity` + a single `cost_price` is a **snapshot, not a
history**. It tells you how many you have, but not what those units actually
cost when supplier prices move between deliveries — so margins drift. This
engine keeps a **cost lot per delivery**, which is what makes COGS true.
Recommended: keep `stock_quantity` as your fast read, and let the engine be the
source of truth for cost.

Two helpers for the transition:

- `openingLotsFromProducts(rows)` — seeds opening cost lots from
  `cost_price × stock_quantity` so COGS is sensible from day one, before you
  have movement history.
- `reconcileStock(rows, valuationByProduct)` — flags drift between the snapshot
  and the computed on-hand, so disagreements surface instead of hiding.

### Suggested order

1. **Use it read-only first.** Run the ledger over existing data with
   `productCostIndex(products)` and look at `compareToRecordedCost()` and
   `reconcileStock()`. Change nothing; just see whether your numbers drift.
2. **Apply the migration** if the drift matters, and start writing `unit_cost`
   on stock-ins. FIFO becomes exact from that point forward.
3. **Seed opening lots** with `openingLotsFromProducts()` so products with stock
   but no history still have a cost basis.
4. **Wire it into reporting** — feed `result.totals` into your P&L, and let the
   AI advisor read the real margins instead of the snapshot ones.

**We never need your keys, your database, or access to your project.**

---

Built as a standalone handoff for **Ursella** (@wallyngwa). Drop it into your own
repo, wire the adapter, and it's yours.
