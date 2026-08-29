// Ursella FIFO Engine — REAL adapter, mapped to Huncho's actual Supabase schema.
//
// Confirmed schema (supplied 2026-08-28):
//
//   products               id, business_id, category_id, supplier_id, name,
//                          description, sku, selling_price numeric,
//                          cost_price numeric, stock_quantity int,
//                          minimum_stock_level int, image_url, is_active,
//                          created_at, updated_at
//
//   inventory_transactions id, business_id, product_id,
//                          transaction_type inventory_transaction_type (enum),
//                          quantity int, reference_type text, reference_id uuid,
//                          notes text, created_by uuid, created_at
//
//   sale_items             id, sale_id, business_id, product_id (NULLABLE),
//                          product_name_snapshot text, quantity int,
//                          unit_price numeric, unit_cost numeric,
//                          discount numeric, subtotal numeric, total numeric,
//                          created_at
//
// TWO THINGS THIS SCHEMA FORCES US TO HANDLE — see README "Your schema":
//
//  1. inventory_transactions has NO unit_cost column. FIFO needs a cost per
//     receipt, so cost must be resolved from elsewhere. `costResolver` below
//     does that (defaults to products.cost_price). Adding a nullable
//     `unit_cost numeric` to inventory_transactions is the real fix — the
//     migration is in migrations/001_add_unit_cost.sql.
//
//  2. sale_items.product_id is NULLABLE (deleted products keep
//     product_name_snapshot). Those rows cannot be costed and are skipped with
//     a warning rather than silently dropped.
//
// Credential-free: nothing here connects to Supabase. You fetch rows however
// you already do and pass them in.

import type {
  AdjustmentEvent,
  InventoryEvent,
  Product,
  ReceiptEvent,
  ReturnEvent,
  SaleEvent,
} from './types.ts';
import type { SourceAdapter } from './adapter.ts';

// --- Row shapes (match the confirmed schema) --------------------------------

export interface UrsellaProductRow {
  id: string;
  business_id: string;
  category_id: string | null;
  supplier_id: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  selling_price: number | string;
  cost_price: number | string;
  stock_quantity: number;
  minimum_stock_level: number | null;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UrsellaInventoryTransactionRow {
  id: string;
  business_id: string;
  product_id: string;
  transaction_type: string; // pg enum inventory_transaction_type
  quantity: number;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  /** Not in the schema today — read if you apply migrations/001_add_unit_cost.sql. */
  unit_cost?: number | string | null;
}

export interface UrsellaSaleItemRow {
  id: string;
  sale_id: string;
  business_id: string;
  product_id: string | null; // NULLABLE — product may have been deleted
  product_name_snapshot: string;
  quantity: number;
  unit_price: number | string;
  unit_cost: number | string; // cost snapshotted at sale time (their current COGS)
  discount: number | string;
  subtotal: number | string;
  total: number | string;
  created_at: string;
}

/** Postgres `numeric` arrives as a string via supabase-js/PostgREST. Normalize. */
export function num(v: number | string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Map an inventory_transaction_type enum value to an engine event kind.
 * Deliberately tolerant — the exact enum labels weren't supplied, so this
 * matches the usual naming. Override via `transactionTypeMap` if yours differ.
 */
export function classifyTransaction(
  t: string,
): 'receipt' | 'return' | 'adjustment' | 'sale' | 'skip' {
  const s = (t || '').toLowerCase().trim();
  if (/(purchase|receipt|restock|stock_in|stockin|delivery|grn|supply|inbound|opening)/.test(s)) return 'receipt';
  if (/return/.test(s)) return 'return';
  if (/(sale|sold|pos|checkout|outbound)/.test(s)) return 'sale';
  if (/(transfer)/.test(s)) return 'skip';
  return 'adjustment'; // adjustment, damage, shrinkage, count, correction, write_off...
}

/** Resolve the unit cost for a stock-in row, since the table has no cost column. */
export type CostResolver = (
  row: UrsellaInventoryTransactionRow,
  ctx: { productCost: number | undefined },
) => number;

export interface UrsellaAdapterOptions {
  /** Explicit enum-label → kind overrides, e.g. { stock_take: "adjustment" }. */
  transactionTypeMap?: Record<string, 'receipt' | 'return' | 'adjustment' | 'sale' | 'skip'>;
  /** products.cost_price by product id — the default cost basis for receipts. */
  productCostById?: Record<string, number>;
  /** Custom cost resolution. Default: row.unit_cost if present, else products.cost_price. */
  costResolver?: CostResolver;
  /**
   * Revenue basis for sale_items. Default "total" — it already accounts for
   * discount, so margins reflect what the customer actually paid.
   */
  revenueBasis?: 'total' | 'subtotal' | 'unit_price';
}

/** Rows we could not cost, surfaced instead of silently dropped. */
export interface AdapterIssue {
  rowId: string;
  code: 'null_product_id' | 'missing_cost';
  message: string;
}

export interface UrsellaAdapter
  extends SourceAdapter<UrsellaProductRow, UrsellaInventoryTransactionRow, UrsellaSaleItemRow> {
  issues: AdapterIssue[];
}

export function createUrsellaAdapter(options: UrsellaAdapterOptions = {}): UrsellaAdapter {
  const {
    transactionTypeMap = {},
    productCostById = {},
    revenueBasis = 'total',
    costResolver,
  } = options;

  const issues: AdapterIssue[] = [];

  const resolveCost: CostResolver =
    costResolver ??
    ((row, ctx) => {
      if (row.unit_cost !== undefined && row.unit_cost !== null) return num(row.unit_cost);
      if (ctx.productCost !== undefined) return ctx.productCost;
      issues.push({
        rowId: row.id,
        code: 'missing_cost',
        message:
          'inventory_transactions has no unit_cost and no products.cost_price was supplied for product ' +
          row.product_id +
          '; costed at 0. Apply migrations/001_add_unit_cost.sql to fix this properly.',
      });
      return 0;
    });

  return {
    issues,

    toProduct: (r): Product => ({
      id: r.id,
      name: r.name,
      sku: r.sku ?? undefined,
    }),

    stockMovementToEvent: (r): ReceiptEvent | ReturnEvent | AdjustmentEvent | null => {
      const kind = transactionTypeMap[r.transaction_type] ?? classifyTransaction(r.transaction_type);

      // Sales are costed from sale_items. Ignoring the mirrored inventory row
      // prevents stock being consumed twice for the same sale.
      if (kind === 'sale' || kind === 'skip') return null;

      const base = { id: r.id, productId: r.product_id, occurredAt: r.created_at };
      const qty = num(r.quantity);
      const productCost = productCostById[r.product_id];

      if (kind === 'receipt') {
        return {
          kind: 'receipt',
          ...base,
          quantity: Math.abs(qty),
          unitCost: resolveCost(r, { productCost }),
        };
      }

      if (kind === 'return') {
        return {
          kind: 'return',
          ...base,
          quantity: Math.abs(qty),
          unitCost: r.unit_cost === undefined || r.unit_cost === null ? undefined : num(r.unit_cost),
        };
      }

      // Adjustment: sign carries direction. Positive adjustments add stock and
      // therefore need a cost basis; negative ones just consume lots.
      return {
        kind: 'adjustment',
        ...base,
        quantity: qty,
        unitCost: qty > 0 ? resolveCost(r, { productCost }) : undefined,
        reason: r.notes ?? r.transaction_type ?? undefined,
      };
    },

    saleLineItemToEvent: (r): SaleEvent | null => {
      // product_id is nullable — a deleted product can't be costed against stock.
      if (!r.product_id) {
        issues.push({
          rowId: r.id,
          code: 'null_product_id',
          message:
            'sale_items row has a NULL product_id (' +
            r.product_name_snapshot +
            '); cannot be costed, skipped.',
        });
        return null;
      }

      const qty = num(r.quantity);
      // Revenue basis. `total` is already net of discount, so we convert it to an
      // effective per-unit price — the engine multiplies it back by quantity,
      // keeping revenue exactly equal to what was charged.
      let effectiveUnitPrice: number;
      if (revenueBasis === 'unit_price') {
        effectiveUnitPrice = num(r.unit_price);
      } else {
        const gross = revenueBasis === 'subtotal' ? num(r.subtotal) : num(r.total);
        effectiveUnitPrice = qty !== 0 ? gross / qty : 0;
      }

      return {
        kind: 'sale',
        id: r.id,
        productId: r.product_id,
        occurredAt: r.created_at,
        quantity: qty,
        unitPrice: effectiveUnitPrice,
        saleId: r.sale_id,
      };
    },
  };
}

/** Build the products.cost_price lookup the adapter uses as its cost basis. */
export function productCostIndex(rows: UrsellaProductRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.id] = num(r.cost_price);
  return out;
}

/**
 * Seed opening cost lots from products.cost_price x stock_quantity.
 *
 * For the cutover: if stock exists today with no transaction history behind it,
 * this gives every product a cost basis so COGS is sensible from day one.
 * Run once, dated before the first real transaction.
 */
export function openingLotsFromProducts(
  rows: UrsellaProductRow[],
  openingDate = '1970-01-01T00:00:00Z',
): InventoryEvent[] {
  const events: InventoryEvent[] = [];
  for (const r of rows) {
    const qty = num(r.stock_quantity);
    if (qty > 0) {
      events.push({
        kind: 'receipt',
        id: 'opening:' + r.id,
        productId: r.id,
        occurredAt: openingDate,
        quantity: qty,
        unitCost: num(r.cost_price),
      });
    }
  }
  return events;
}

/** Filter any tenant-scoped row set to one business before costing. */
export function forBusiness<T extends { business_id?: string }>(rows: T[], businessId: string): T[] {
  return rows.filter((r) => r.business_id === undefined || r.business_id === businessId);
}

/**
 * Compare the engine's FIFO COGS against sale_items.unit_cost (the cost Ursella
 * snapshots at sale time). Divergence is expected and is exactly the point:
 * a single snapshot cost can't track price changes between deliveries. This
 * quantifies how far off the current numbers are.
 */
export function compareToRecordedCost(
  saleItems: UrsellaSaleItemRow[],
  sales: Array<{ saleEventId: string; cogs: number }>,
): {
  rows: Array<{ saleItemId: string; recordedCogs: number; fifoCogs: number; difference: number }>;
  totalRecorded: number;
  totalFifo: number;
  totalDifference: number;
} {
  const fifoById = new Map(sales.map((s) => [s.saleEventId, s.cogs]));
  const rows: Array<{ saleItemId: string; recordedCogs: number; fifoCogs: number; difference: number }> = [];
  let totalRecorded = 0;
  let totalFifo = 0;

  for (const item of saleItems) {
    const fifoCogs = fifoById.get(item.id);
    if (fifoCogs === undefined) continue;
    const recordedCogs = num(item.unit_cost) * num(item.quantity);
    totalRecorded += recordedCogs;
    totalFifo += fifoCogs;
    const difference = Math.round((fifoCogs - recordedCogs) * 100) / 100;
    if (difference !== 0) rows.push({ saleItemId: item.id, recordedCogs, fifoCogs, difference });
  }

  return {
    rows,
    totalRecorded: Math.round(totalRecorded * 100) / 100,
    totalFifo: Math.round(totalFifo * 100) / 100,
    totalDifference: Math.round((totalFifo - totalRecorded) * 100) / 100,
  };
}

/**
 * Reconcile computed on-hand against products.stock_quantity. Drift means the
 * transaction history and the snapshot disagree — surface it rather than
 * trusting either blindly.
 */
export function reconcileStock(
  rows: UrsellaProductRow[],
  valuationByProduct: Record<string, { quantityOnHand: number }>,
): Array<{ productId: string; name: string; snapshot: number; computed: number; drift: number }> {
  const out: Array<{ productId: string; name: string; snapshot: number; computed: number; drift: number }> = [];
  for (const r of rows) {
    const snapshot = num(r.stock_quantity);
    const computed = valuationByProduct[r.id]?.quantityOnHand ?? 0;
    const drift = computed - snapshot;
    if (drift !== 0) out.push({ productId: r.id, name: r.name, snapshot, computed, drift });
  }
  return out;
}
