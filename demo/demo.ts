// Runnable demo with sample data. No database, no keys — just plain rows.
// Run with:  node demo/demo.ts
//
// It builds events from example Supabase-shaped rows via the example adapter,
// runs the ledger, and prints COGS/margin per sale, totals, and inventory value.

import { runLedger } from '../src/engine.ts';
import { buildInput, exampleSupabaseAdapter } from '../src/adapter.ts';
import type {
  ExampleProductRow,
  ExampleSaleLineRow,
  ExampleStockMovementRow,
} from '../src/adapter.ts';

const products: ExampleProductRow[] = [
  { id: 'p_rice', name: 'Rice 5kg', sku: 'RICE5', unit: 'bag', currency: 'GHS' },
  { id: 'p_oil', name: 'Cooking Oil 1L', sku: 'OIL1', unit: 'bottle', currency: 'GHS' },
];

const stockMovements: ExampleStockMovementRow[] = [
  { id: 'm1', product_id: 'p_rice', movement_type: 'receipt', quantity: 20, unit_cost: 30, occurred_at: '2026-08-01T08:00:00Z', note: null },
  { id: 'm2', product_id: 'p_rice', movement_type: 'receipt', quantity: 20, unit_cost: 34, occurred_at: '2026-08-10T08:00:00Z', note: 'supplier price rose' },
  { id: 'm3', product_id: 'p_oil', movement_type: 'receipt', quantity: 40, unit_cost: 12, occurred_at: '2026-08-02T08:00:00Z', note: null },
  { id: 'm4', product_id: 'p_rice', movement_type: 'adjustment', quantity: -1, unit_cost: null, occurred_at: '2026-08-12T08:00:00Z', note: 'damaged bag' },
  { id: 'm5', product_id: 'p_oil', movement_type: 'return', quantity: 2, unit_cost: null, occurred_at: '2026-08-15T09:00:00Z', note: 'customer return' },
];

const saleLineItems: ExampleSaleLineRow[] = [
  { id: 's1', sale_id: 'o1', product_id: 'p_rice', quantity: 25, unit_price: 38, sold_at: '2026-08-11T10:00:00Z' },
  { id: 's2', sale_id: 'o1', product_id: 'p_oil', quantity: 10, unit_price: 16, sold_at: '2026-08-11T10:00:00Z' },
  { id: 's3', sale_id: 'o2', product_id: 'p_oil', quantity: 5, unit_price: 16, sold_at: '2026-08-14T14:00:00Z' },
];

const { events } = buildInput(exampleSupabaseAdapter, { products, stockMovements, saleLineItems });
const result = runLedger(events, { roundingDecimals: 2 });

console.log('=== Ursella FIFO Engine — demo run ===\n');
console.log('Per-sale:');
for (const s of result.sales) {
  const pct = (s.grossMarginRate * 100).toFixed(1);
  console.log(
    `  ${s.saleEventId} ${s.productId}  qty ${s.quantity}  revenue ${s.revenue}  COGS ${s.cogs}  margin ${s.grossMargin} (${pct}%)`,
  );
}

console.log('\nTotals:', result.totals);

console.log('\nInventory on hand:');
for (const [pid, v] of Object.entries(result.valuationByProduct)) {
  console.log(`  ${pid}: ${v.quantityOnHand} on hand  value ${v.inventoryValue}  avg cost ${v.averageUnitCost}`);
}

if (result.warnings.length) {
  console.log('\nWarnings:');
  for (const w of result.warnings) console.log(`  [${w.code}] ${w.productId}: ${w.message}`);
}
