// Ursella FIFO Engine — data contract & result types.
//
// Pure type declarations. No runtime code, no imports, no I/O.
// Credential-free by construction: this file describes the SHAPE of data the
// engine works on. It never reads your database, your keys, or your network.

/** ISO-8601 string ("2026-08-28T18:05:00Z") or epoch milliseconds. */
export type Timestamp = string | number;

/** A product / SKU in the catalog. */
export interface Product {
  id: string;
  name: string;
  sku?: string;
  unit?: string; // "each", "kg", "bag", "bottle"...
  currency?: string; // ISO 4217 — informational only; the engine is currency-agnostic
}

/** Behavioural + rounding options for a ledger run. */
export interface EngineOptions {
  /** Decimal places for monetary outputs (revenue, COGS, margins, values). Default 2. */
  roundingDecimals?: number;
  /**
   * What to do when a sale (or negative movement) exceeds stock on hand.
   * - "shortfall" (default): cost only the units actually in stock; report the rest
   *   as `shortfallQuantity` so nothing is silently invented.
   * - "backorder": also cost the uncovered units using `fallbackUnitCost`.
   */
  insufficientStock?: 'shortfall' | 'backorder';
  /** Unit cost used for uncovered units when insufficientStock === "backorder". Default "lastKnown". */
  fallbackUnitCost?: 'lastKnown' | 'zero' | number;
  /** How to cost customer-returned goods put back on the shelf. Default "lastConsumed". */
  returnRestockCost?: 'lastConsumed' | 'averageOnHand' | 'explicit';
}

export type EventKind = 'receipt' | 'sale' | 'return' | 'adjustment';

interface BaseEvent {
  id: string;
  productId: string;
  occurredAt: Timestamp;
  /** Optional tiebreak when two events share the same occurredAt. */
  sequence?: number;
}

/** Stock coming IN from a purchase/supply — creates a FIFO cost lot. */
export interface ReceiptEvent extends BaseEvent {
  kind: 'receipt';
  quantity: number; // > 0
  unitCost: number; // per-unit landed cost
}

/** A sale line — consumes lots oldest-first, produces COGS + margin. */
export interface SaleEvent extends BaseEvent {
  kind: 'sale';
  quantity: number; // > 0
  unitPrice: number; // per-unit sale price (revenue)
  saleId?: string; // groups line items that belong to one order/receipt
}

/** Goods returned by a customer — restocked at a cost basis (see returnRestockCost). */
export interface ReturnEvent extends BaseEvent {
  kind: 'return';
  quantity: number; // > 0 (units coming back in)
  unitCost?: number; // used only when returnRestockCost === "explicit"
  againstSaleId?: string; // optional link to the original sale
}

/** Manual correction: +qty adds stock (needs unitCost), -qty writes stock off (shrinkage). */
export interface AdjustmentEvent extends BaseEvent {
  kind: 'adjustment';
  quantity: number; // signed: +in / -out
  unitCost?: number; // required for positive adjustments; ignored for negative
  reason?: string;
}

export type InventoryEvent = ReceiptEvent | SaleEvent | ReturnEvent | AdjustmentEvent;

/** An open (or partially consumed) FIFO cost lot. */
export interface CostLot {
  lotId: string;
  productId: string;
  unitCost: number;
  quantityRemaining: number;
  originalQuantity: number;
  receivedAt: Timestamp;
  sourceEventId: string;
}

/** One slice consumed from a lot to satisfy an outflow. */
export interface LotConsumption {
  lotId: string;
  quantity: number;
  unitCost: number;
}

/** Result of costing a single sale line. */
export interface SaleResult {
  saleEventId: string;
  saleId?: string;
  productId: string;
  quantity: number;
  revenue: number;
  cogs: number;
  grossMargin: number; // revenue - cogs
  grossMarginRate: number; // grossMargin / revenue (0 when revenue is 0)
  consumptions: LotConsumption[];
  shortfallQuantity: number; // units that could not be covered from stock
}

/** Something the caller should know about. */
export interface EngineWarning {
  eventId: string;
  productId: string;
  code: 'insufficient_stock' | 'missing_unit_cost';
  message: string;
  quantity?: number;
}

/** End-of-run valuation for one product. */
export interface ProductValuation {
  productId: string;
  quantityOnHand: number;
  inventoryValue: number; // sum(remaining * unitCost)
  averageUnitCost: number; // inventoryValue / quantityOnHand (0 when empty)
  openLots: CostLot[];
}

export interface LedgerTotals {
  revenue: number;
  cogs: number;
  grossMargin: number;
  grossMarginRate: number;
  unitsSold: number;
  inventoryValue: number;
}

export interface LedgerResult {
  sales: SaleResult[];
  valuationByProduct: Record<string, ProductValuation>;
  totals: LedgerTotals;
  warnings: EngineWarning[];
}
