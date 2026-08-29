// Ursella FIFO Engine — deterministic cost-of-goods + margin computation.
//
// Pure logic. Zero dependencies. No database, no network, no keys.
// You feed it an array of InventoryEvent (built from your own rows via the
// adapter) and it returns COGS per sale, running margin, and inventory value.

import type {
  CostLot,
  EngineOptions,
  EngineWarning,
  InventoryEvent,
  LedgerResult,
  LedgerTotals,
  LotConsumption,
  ProductValuation,
  SaleEvent,
  SaleResult,
  Timestamp,
} from './types.ts';

type ResolvedOptions = Required<EngineOptions>;

const DEFAULTS: ResolvedOptions = {
  roundingDecimals: 2,
  insufficientStock: 'shortfall',
  fallbackUnitCost: 'lastKnown',
  returnRestockCost: 'lastConsumed',
};

function toMillis(t: Timestamp): number {
  return typeof t === 'number' ? t : Date.parse(t);
}

/**
 * Round half-up (away from zero on ties) to `decimals` places, stable against
 * binary FP drift. The correction is scaled with magnitude so accumulated
 * error — e.g. 3 * 1.005 landing at 3.0149999999999997 — still rounds the way
 * a human expects (3.02), while genuine values below the tie (3.0149) do not.
 */
export function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.pow(10, decimals);
  return Math.round(value * f * (1 + Number.EPSILON)) / f;
}

interface ProductState {
  lots: CostLot[]; // FIFO queue, oldest at index 0
  lastConsumedUnitCost: number | null;
}

function stateFor(map: Map<string, ProductState>, productId: string): ProductState {
  let s = map.get(productId);
  if (!s) {
    s = { lots: [], lastConsumedUnitCost: null };
    map.set(productId, s);
  }
  return s;
}

function quantityOnHand(state: ProductState): number {
  let q = 0;
  for (const lot of state.lots) q += lot.quantityRemaining;
  return q;
}

function inventoryValue(state: ProductState): number {
  let v = 0;
  for (const lot of state.lots) v += lot.quantityRemaining * lot.unitCost;
  return v;
}

function averageUnitCost(state: ProductState): number {
  const q = quantityOnHand(state);
  return q > 0 ? inventoryValue(state) / q : 0;
}

function makeLot(
  productId: string,
  unitCost: number,
  quantity: number,
  receivedAt: Timestamp,
  sourceEventId: string,
  seq: number,
): CostLot {
  return {
    lotId: sourceEventId + '#' + seq,
    productId,
    unitCost,
    quantityRemaining: quantity,
    originalQuantity: quantity,
    receivedAt,
    sourceEventId,
  };
}

/** Consume `quantity` from a product's lots, oldest-first. Mutates the state. */
function consumeFifo(
  state: ProductState,
  quantity: number,
): { consumptions: LotConsumption[]; covered: number; shortfall: number } {
  const consumptions: LotConsumption[] = [];
  let remaining = quantity;
  while (remaining > 0 && state.lots.length > 0) {
    const lot = state.lots[0];
    const take = Math.min(lot.quantityRemaining, remaining);
    lot.quantityRemaining -= take;
    remaining -= take;
    state.lastConsumedUnitCost = lot.unitCost;
    consumptions.push({ lotId: lot.lotId, quantity: take, unitCost: lot.unitCost });
    if (lot.quantityRemaining <= 0) state.lots.shift();
  }
  return { consumptions, covered: quantity - remaining, shortfall: remaining };
}

function resolveFallback(fallback: ResolvedOptions['fallbackUnitCost'], state: ProductState): number {
  if (typeof fallback === 'number') return fallback;
  if (fallback === 'zero') return 0;
  return state.lastConsumedUnitCost ?? averageUnitCost(state); // "lastKnown"
}

function resolveReturnCost(
  explicit: number | undefined,
  strategy: ResolvedOptions['returnRestockCost'],
  state: ProductState,
): number {
  if (strategy === 'explicit') return explicit ?? state.lastConsumedUnitCost ?? averageUnitCost(state);
  if (strategy === 'averageOnHand') return averageUnitCost(state);
  return state.lastConsumedUnitCost ?? explicit ?? averageUnitCost(state); // "lastConsumed"
}

function costSale(
  ev: SaleEvent,
  state: ProductState,
  opt: ResolvedOptions,
  warnings: EngineWarning[],
): SaleResult {
  const d = opt.roundingDecimals;
  const { consumptions, covered, shortfall } = consumeFifo(state, ev.quantity);
  let cogsRaw = 0;
  for (const c of consumptions) cogsRaw += c.quantity * c.unitCost;

  let shortfallQuantity = shortfall;
  if (shortfall > 0) {
    if (opt.insufficientStock === 'backorder') {
      const fb = resolveFallback(opt.fallbackUnitCost, state);
      cogsRaw += shortfall * fb;
      consumptions.push({ lotId: '(backorder)', quantity: shortfall, unitCost: fb });
      shortfallQuantity = 0;
      warnings.push({
        eventId: ev.id,
        productId: ev.productId,
        code: 'insufficient_stock',
        message: 'Sold ' + shortfall + ' unit(s) beyond stock; costed at fallback ' + round(fb, d) + ' (backorder).',
        quantity: shortfall,
      });
    } else {
      warnings.push({
        eventId: ev.id,
        productId: ev.productId,
        code: 'insufficient_stock',
        message: 'Sold ' + ev.quantity + ' but only ' + covered + ' in stock; ' + shortfall + ' unit(s) left uncosted (shortfall).',
        quantity: shortfall,
      });
    }
  }

  const revenue = round(ev.quantity * ev.unitPrice, d);
  const cogs = round(cogsRaw, d);
  const grossMargin = round(revenue - cogs, d);
  return {
    saleEventId: ev.id,
    saleId: ev.saleId,
    productId: ev.productId,
    quantity: ev.quantity,
    revenue,
    cogs,
    grossMargin,
    grossMarginRate: revenue > 0 ? round(grossMargin / revenue, 4) : 0,
    consumptions,
    shortfallQuantity,
  };
}

/**
 * Run the full ledger over a list of events.
 * Events are processed in deterministic order: occurredAt, then `sequence`,
 * then original array index — so input order never changes the result.
 */
export function runLedger(events: InventoryEvent[], options: EngineOptions = {}): LedgerResult {
  const opt: ResolvedOptions = { ...DEFAULTS, ...options };
  const d = opt.roundingDecimals;
  const states = new Map<string, ProductState>();
  const sales: SaleResult[] = [];
  const warnings: EngineWarning[] = [];
  let lotSeq = 0;

  const ordered = events
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        toMillis(a.e.occurredAt) - toMillis(b.e.occurredAt) ||
        (a.e.sequence ?? 0) - (b.e.sequence ?? 0) ||
        a.i - b.i,
    )
    .map((x) => x.e);

  for (const ev of ordered) {
    const state = stateFor(states, ev.productId);
    if (ev.kind === 'receipt') {
      state.lots.push(makeLot(ev.productId, ev.unitCost, ev.quantity, ev.occurredAt, ev.id, ++lotSeq));
    } else if (ev.kind === 'return') {
      const cost = resolveReturnCost(ev.unitCost, opt.returnRestockCost, state);
      state.lots.push(makeLot(ev.productId, cost, ev.quantity, ev.occurredAt, ev.id, ++lotSeq));
    } else if (ev.kind === 'adjustment') {
      if (ev.quantity >= 0) {
        const cost = ev.unitCost ?? averageUnitCost(state);
        if (ev.unitCost === undefined) {
          warnings.push({
            eventId: ev.id,
            productId: ev.productId,
            code: 'missing_unit_cost',
            message: 'Positive adjustment without unitCost; used average on-hand cost ' + round(cost, d) + '.',
            quantity: ev.quantity,
          });
        }
        if (ev.quantity > 0) {
          state.lots.push(makeLot(ev.productId, cost, ev.quantity, ev.occurredAt, ev.id, ++lotSeq));
        }
      } else {
        const { shortfall } = consumeFifo(state, -ev.quantity);
        if (shortfall > 0) {
          warnings.push({
            eventId: ev.id,
            productId: ev.productId,
            code: 'insufficient_stock',
            message: 'Negative adjustment exceeded stock on hand by ' + shortfall + ' unit(s).',
            quantity: shortfall,
          });
        }
      }
    } else if (ev.kind === 'sale') {
      sales.push(costSale(ev, state, opt, warnings));
    }
  }

  const valuationByProduct: Record<string, ProductValuation> = {};
  let totalInventoryValue = 0;
  for (const [productId, state] of states) {
    const q = quantityOnHand(state);
    const v = inventoryValue(state);
    totalInventoryValue += v;
    valuationByProduct[productId] = {
      productId,
      quantityOnHand: round(q, 6),
      inventoryValue: round(v, d),
      averageUnitCost: q > 0 ? round(v / q, d) : 0,
      openLots: state.lots.map((l) => ({ ...l })),
    };
  }

  let revenue = 0;
  let cogs = 0;
  let unitsSold = 0;
  for (const s of sales) {
    revenue += s.revenue;
    cogs += s.cogs;
    unitsSold += s.quantity;
  }
  const grossMargin = round(revenue - cogs, d);
  const totals: LedgerTotals = {
    revenue: round(revenue, d),
    cogs: round(cogs, d),
    grossMargin,
    grossMarginRate: revenue > 0 ? round(grossMargin / revenue, 4) : 0,
    unitsSold: round(unitsSold, 6),
    inventoryValue: round(totalInventoryValue, d),
  };

  return { sales, valuationByProduct, totals, warnings };
}
