// Runnable demo on YOUR real tables: products / inventory_transactions / sale_items.
// No database, no keys — just plain rows shaped exactly like your Supabase ones.
//
// Run:  npm run demo
//
// The story below is deliberately the case that breaks snapshot costing:
// the supplier price rises between two deliveries, so a single cost_price
// can no longer tell you what you actually earned.

import { runLedger } from '../src/engine.ts';
import { buildInput } from '../src/adapter.ts';
import {
  compareToRecordedCost,
  createUrsellaAdapter,
  productCostIndex,
  reconcileStock,
} from '../src/ursella-adapter.ts';
import type {
  UrsellaInventoryTransactionRow,
  UrsellaProductRow,
  UrsellaSaleItemRow,
} from '../src/ursella-adapter.ts';

const BIZ = 'b0000000-0000-0000-0000-000000000001';
const RICE = 'a0000000-0000-0000-0000-0000000000r1';
const OIL = 'a0000000-0000-0000-0000-0000000000o1';

const products: UrsellaProductRow[] = [
  {
    id: RICE, business_id: BIZ, category_id: null, supplier_id: null,
    name: 'Rice 5kg', description: null, sku: 'RICE5',
    selling_price: '38.00', cost_price: '34.00', // current cost — note it ROSE
    stock_quantity: 14, minimum_stock_level: 5, image_url: null, is_active: true,
    created_at: '2026-08-01T08:00:00Z', updated_at: '2026-08-10T08:00:00Z',
  },
  {
    id: OIL, business_id: BIZ, category_id: null, supplier_id: null,
    name: 'Cooking Oil 1L', description: null, sku: 'OIL1',
    selling_price: '16.00', cost_price: '12.00',
    stock_quantity: 27, minimum_stock_level: 10, image_url: null, is_active: true,
    created_at: '2026-08-02T08:00:00Z', updated_at: '2026-08-02T08:00:00Z',
  },
];

const inventoryTransactions: UrsellaInventoryTransactionRow[] = [
  { id: 't1', business_id: BIZ, product_id: RICE, transaction_type: 'purchase', quantity: 20, unit_cost: '30.00', reference_type: null, reference_id: null, notes: 'first delivery', created_by: null, created_at: '2026-08-01T08:00:00Z' },
  { id: 't2', business_id: BIZ, product_id: RICE, transaction_type: 'purchase', quantity: 20, unit_cost: '34.00', reference_type: null, reference_id: null, notes: 'supplier raised price', created_by: null, created_at: '2026-08-10T08:00:00Z' },
  { id: 't3', business_id: BIZ, product_id: OIL, transaction_type: 'purchase', quantity: 40, unit_cost: '12.00', reference_type: null, reference_id: null, notes: null, created_by: null, created_at: '2026-08-02T08:00:00Z' },
  { id: 't4', business_id: BIZ, product_id: RICE, transaction_type: 'damage', quantity: -1, reference_type: null, reference_id: null, notes: 'torn bag', created_by: null, created_at: '2026-08-12T08:00:00Z' },
  { id: 't5', business_id: BIZ, product_id: OIL, transaction_type: 'customer_return', quantity: 2, reference_type: null, reference_id: null, notes: null, created_by: null, created_at: '2026-08-15T09:00:00Z' },
];

const saleItems: UrsellaSaleItemRow[] = [
  // 25 bags sold: 20 came from the 30 lot, 5 from the 34 lot. A single
  // cost_price of 34 would say these cost 850. FIFO says 770.
  { id: 'si1', sale_id: 'o1', business_id: BIZ, product_id: RICE, product_name_snapshot: 'Rice 5kg', quantity: 25, unit_price: '38.00', unit_cost: '34.00', discount: '0', subtotal: '950.00', total: '950.00', created_at: '2026-08-11T10:00:00Z' },
  { id: 'si2', sale_id: 'o1', business_id: BIZ, product_id: OIL, product_name_snapshot: 'Cooking Oil 1L', quantity: 10, unit_price: '16.00', unit_cost: '12.00', discount: '0', subtotal: '160.00', total: '160.00', created_at: '2026-08-11T10:00:00Z' },
  // A discounted line: listed 80, sold for 72.
  { id: 'si3', sale_id: 'o2', business_id: BIZ, product_id: OIL, product_name_snapshot: 'Cooking Oil 1L', quantity: 5, unit_price: '16.00', unit_cost: '12.00', discount: '8.00', subtotal: '80.00', total: '72.00', created_at: '2026-08-14T14:00:00Z' },
  // A deleted product: product_id is NULL, so it can't be costed — reported, not dropped.
  { id: 'si4', sale_id: 'o3', business_id: BIZ, product_id: null, product_name_snapshot: 'Discontinued item', quantity: 1, unit_price: '5.00', unit_cost: '3.00', discount: '0', subtotal: '5.00', total: '5.00', created_at: '2026-08-16T11:00:00Z' },
];

const adapter = createUrsellaAdapter({ productCostById: productCostIndex(products) });
const { events } = buildInput(adapter, {
  products,
  stockMovements: inventoryTransactions,
  saleLineItems: saleItems,
});
const result = runLedger(events, { roundingDecimals: 2 });

console.log('=== Ursella FIFO engine — demo on your schema ===\n');

console.log('Per sale line:');
for (const s of result.sales) {
  const pct = (s.grossMarginRate * 100).toFixed(1);
  console.log(`  ${s.saleEventId}  qty ${s.quantity}  revenue ${s.revenue}  COGS ${s.cogs}  margin ${s.grossMargin} (${pct}%)`);
}

console.log('\nTotals:', result.totals);

console.log('\nStock on hand (computed from transactions):');
for (const [pid, v] of Object.entries(result.valuationByProduct)) {
  const name = products.find((p) => p.id === pid)?.name ?? pid;
  console.log(`  ${name}: ${v.quantityOnHand} @ avg ${v.averageUnitCost} = ${v.inventoryValue}`);
}

const drift = reconcileStock(products, result.valuationByProduct);
console.log('\nReconciliation vs products.stock_quantity:');
console.log(drift.length ? drift : '  no drift — snapshot agrees with transaction history');

const cmp = compareToRecordedCost(saleItems, result.sales);
console.log('\nYour recorded cost (sale_items.unit_cost) vs true FIFO cost:');
console.log(`  recorded ${cmp.totalRecorded}   FIFO ${cmp.totalFifo}   difference ${cmp.totalDifference}`);
if (cmp.totalDifference < 0) {
  console.log(`  -> snapshot costing OVERSTATES COGS by ${Math.abs(cmp.totalDifference)}, understating profit`);
} else if (cmp.totalDifference > 0) {
  console.log(`  -> snapshot costing UNDERSTATES COGS by ${cmp.totalDifference}, overstating profit`);
}

if (adapter.issues.length) {
  console.log('\nRows that could not be costed (surfaced, not silently dropped):');
  for (const i of adapter.issues) console.log(`  [${i.code}] ${i.message}`);
}
