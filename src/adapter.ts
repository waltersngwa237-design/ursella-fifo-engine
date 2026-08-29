// Ursella FIFO Engine — adapter layer.
//
// THIS is the only file you edit to match your Supabase schema. The engine
// itself never sees your database — you read your rows however you already do
// (Supabase client, Edge Function, an export, whatever), map them here, and
// hand the events to runLedger(). No keys, no connection strings, nothing
// leaves your systems.

import type {
  AdjustmentEvent,
  InventoryEvent,
  Product,
  ReceiptEvent,
  ReturnEvent,
  SaleEvent,
} from './types.ts';

/** Map YOUR row shapes into the engine's contract. Fill in the three functions. */
export interface SourceAdapter<ProductRow, MovementRow, SaleLineRow> {
  toProduct(row: ProductRow): Product;
  /** Return a receipt / return / adjustment event — or null to skip the row. */
  stockMovementToEvent(row: MovementRow): ReceiptEvent | ReturnEvent | AdjustmentEvent | null;
  /** Return a sale event — or null to skip the row. */
  saleLineItemToEvent(row: SaleLineRow): SaleEvent | null;
}

export interface SourceTables<ProductRow, MovementRow, SaleLineRow> {
  products: ProductRow[];
  stockMovements: MovementRow[];
  saleLineItems: SaleLineRow[];
}

export interface BuiltInput {
  products: Product[];
  events: InventoryEvent[];
}

/** Turn your three tables into the { products, events } the engine consumes. */
export function buildInput<ProductRow, MovementRow, SaleLineRow>(
  adapter: SourceAdapter<ProductRow, MovementRow, SaleLineRow>,
  tables: SourceTables<ProductRow, MovementRow, SaleLineRow>,
): BuiltInput {
  const products = tables.products.map((r) => adapter.toProduct(r));
  const events: InventoryEvent[] = [];
  for (const r of tables.stockMovements) {
    const e = adapter.stockMovementToEvent(r);
    if (e) events.push(e);
  }
  for (const r of tables.saleLineItems) {
    const e = adapter.saleLineItemToEvent(r);
    if (e) events.push(e);
  }
  return { products, events };
}

// ---------------------------------------------------------------------------
// GENERIC EXAMPLE — kept only to show the shape of an adapter.
//
// YOU DO NOT NEED THIS. The live adapter for Ursella's actual tables
// (products / inventory_transactions / sale_items) is in `ursella-adapter.ts`
// — use `createUrsellaAdapter()` from there. This block is a reference for
// mapping some other schema later, and can be deleted.
// ---------------------------------------------------------------------------

export interface ExampleProductRow {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  currency: string | null;
}

export interface ExampleStockMovementRow {
  id: string;
  product_id: string;
  movement_type: 'receipt' | 'return' | 'adjustment';
  quantity: number; // signed for adjustments (+in / -out); positive for receipt/return
  unit_cost: number | null; // required for receipts; optional otherwise
  occurred_at: string; // ISO timestamp
  note: string | null;
}

export interface ExampleSaleLineRow {
  id: string;
  sale_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  sold_at: string; // ISO timestamp
}

export const exampleSupabaseAdapter: SourceAdapter<
  ExampleProductRow,
  ExampleStockMovementRow,
  ExampleSaleLineRow
> = {
  toProduct: (r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku ?? undefined,
    unit: r.unit ?? undefined,
    currency: r.currency ?? undefined,
  }),

  stockMovementToEvent: (r) => {
    const base = { id: r.id, productId: r.product_id, occurredAt: r.occurred_at };
    if (r.movement_type === 'receipt') {
      return { kind: 'receipt', ...base, quantity: r.quantity, unitCost: r.unit_cost ?? 0 };
    }
    if (r.movement_type === 'return') {
      return { kind: 'return', ...base, quantity: r.quantity, unitCost: r.unit_cost ?? undefined };
    }
    return {
      kind: 'adjustment',
      ...base,
      quantity: r.quantity,
      unitCost: r.unit_cost ?? undefined,
      reason: r.note ?? undefined,
    };
  },

  saleLineItemToEvent: (r) => ({
    kind: 'sale',
    id: r.id,
    productId: r.product_id,
    occurredAt: r.sold_at,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    saleId: r.sale_id,
  }),
};
