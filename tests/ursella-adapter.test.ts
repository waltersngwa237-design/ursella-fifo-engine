// Tests for the REAL Ursella adapter, against the confirmed schema:
// products / inventory_transactions / sale_items.
// Run: node --test tests/ursella-adapter.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLedger } from '../src/engine.ts';
import { buildInput } from '../src/adapter.ts';
import {
  classifyTransaction,
  compareToRecordedCost,
  createUrsellaAdapter,
  forBusiness,
  num,
  openingLotsFromProducts,
  productCostIndex,
  reconcileStock,
} from '../src/ursella-adapter.ts';
import type {
  UrsellaInventoryTransactionRow,
  UrsellaProductRow,
  UrsellaSaleItemRow,
} from '../src/ursella-adapter.ts';

const PID = '11111111-1111-1111-1111-111111111111';

function product(over: Partial<UrsellaProductRow> = {}): UrsellaProductRow {
  return {
    id: PID,
    business_id: 'biz-1',
    category_id: null,
    supplier_id: null,
    name: 'Rice 5kg',
    description: null,
    sku: 'RICE5',
    selling_price: '38.00',
    cost_price: '30.00',
    stock_quantity: 20,
    minimum_stock_level: 5,
    image_url: null,
    is_active: true,
    created_at: '2026-08-01T08:00:00Z',
    updated_at: '2026-08-01T08:00:00Z',
    ...over,
  };
}

function txn(over: Partial<UrsellaInventoryTransactionRow> = {}): UrsellaInventoryTransactionRow {
  return {
    id: 'tx-1',
    business_id: 'biz-1',
    product_id: PID,
    transaction_type: 'purchase',
    quantity: 20,
    reference_type: null,
    reference_id: null,
    notes: null,
    created_by: null,
    created_at: '2026-08-01T08:00:00Z',
    ...over,
  };
}

function saleItem(over: Partial<UrsellaSaleItemRow> = {}): UrsellaSaleItemRow {
  return {
    id: 'si-1',
    sale_id: 'sale-1',
    business_id: 'biz-1',
    product_id: PID,
    product_name_snapshot: 'Rice 5kg',
    quantity: 10,
    unit_price: '38.00',
    unit_cost: '30.00',
    discount: '0',
    subtotal: '380.00',
    total: '380.00',
    created_at: '2026-08-11T10:00:00Z',
    ...over,
  };
}

test('postgres numeric strings are parsed', () => {
  assert.equal(num('30.00'), 30);
  assert.equal(num(null), 0);
  assert.equal(num('junk'), 0);
});

test('inventory_transaction_type classification is tolerant', () => {
  assert.equal(classifyTransaction('purchase'), 'receipt');
  assert.equal(classifyTransaction('stock_in'), 'receipt');
  assert.equal(classifyTransaction('customer_return'), 'return');
  assert.equal(classifyTransaction('sale'), 'sale');
  assert.equal(classifyTransaction('damage'), 'adjustment');
  assert.equal(classifyTransaction('transfer'), 'skip');
});

test('transactionTypeMap overrides the heuristic for custom enum labels', () => {
  const a = createUrsellaAdapter({ transactionTypeMap: { weird_label: 'receipt' }, productCostById: { [PID]: 5 } });
  const ev = a.stockMovementToEvent(txn({ transaction_type: 'weird_label', quantity: 3 }));
  assert.equal(ev?.kind, 'receipt');
});

test('receipts take cost from products.cost_price when the column is absent', () => {
  const products = [product()];
  const a = createUrsellaAdapter({ productCostById: productCostIndex(products) });
  const ev = a.stockMovementToEvent(txn({ quantity: 20 }));
  assert.equal(ev?.kind, 'receipt');
  assert.equal((ev as { unitCost: number }).unitCost, 30);
  assert.equal(a.issues.length, 0);
});

test('receipts prefer unit_cost once the migration adds the column', () => {
  const a = createUrsellaAdapter({ productCostById: { [PID]: 30 } });
  const ev = a.stockMovementToEvent(txn({ unit_cost: '34.00' }));
  assert.equal((ev as { unitCost: number }).unitCost, 34);
});

test('missing cost is reported as an issue, not silently zeroed', () => {
  const a = createUrsellaAdapter(); // no cost index, no unit_cost
  a.stockMovementToEvent(txn());
  assert.equal(a.issues.length, 1);
  assert.equal(a.issues[0].code, 'missing_cost');
});

test('sale_items with NULL product_id are skipped and reported', () => {
  const a = createUrsellaAdapter();
  const ev = a.saleLineItemToEvent(saleItem({ product_id: null, product_name_snapshot: 'Deleted item' }));
  assert.equal(ev, null);
  assert.equal(a.issues.length, 1);
  assert.equal(a.issues[0].code, 'null_product_id');
});

test('revenue uses total, so discounts are respected', () => {
  const a = createUrsellaAdapter();
  // 10 units listed at 38 (=380) but sold for 350 after a 30 discount
  const ev = a.saleLineItemToEvent(saleItem({ discount: '30.00', subtotal: '380.00', total: '350.00' }));
  assert.equal(ev!.quantity * ev!.unitPrice, 350);
});

test('revenueBasis "unit_price" ignores the discount when asked to', () => {
  const a = createUrsellaAdapter({ revenueBasis: 'unit_price' });
  const ev = a.saleLineItemToEvent(saleItem({ discount: '30.00', total: '350.00' }));
  assert.equal(ev!.quantity * ev!.unitPrice, 380);
});

test("mirrored 'sale' inventory rows are skipped so stock isn't double-consumed", () => {
  const a = createUrsellaAdapter();
  assert.equal(a.stockMovementToEvent(txn({ transaction_type: 'sale', quantity: 5 })), null);
});

test('end-to-end on the real schema: FIFO across a price change', () => {
  const products = [product({ stock_quantity: 0, cost_price: '30.00' })];
  const adapter = createUrsellaAdapter({ productCostById: productCostIndex(products) });

  const stockMovements = [
    txn({ id: 'tx1', transaction_type: 'purchase', quantity: 20, unit_cost: '30.00', created_at: '2026-08-01T08:00:00Z' }),
    txn({ id: 'tx2', transaction_type: 'purchase', quantity: 20, unit_cost: '34.00', created_at: '2026-08-10T08:00:00Z' }),
    txn({ id: 'tx3', transaction_type: 'damage', quantity: -1, created_at: '2026-08-12T08:00:00Z' }),
  ];
  const saleLineItems = [
    saleItem({ id: 'si1', quantity: 25, unit_price: '38.00', unit_cost: '30.00', subtotal: '950.00', total: '950.00' }),
  ];

  const { events } = buildInput(adapter, { products, stockMovements, saleLineItems });
  const r = runLedger(events);

  // FIFO: 20 @ 30 + 5 @ 34 = 770
  assert.equal(r.sales[0].cogs, 770);
  assert.equal(r.sales[0].revenue, 950);
  assert.equal(r.sales[0].grossMargin, 180);
  // 40 in - 25 sold - 1 damaged = 14, all from the 34 lot
  assert.equal(r.valuationByProduct[PID].quantityOnHand, 14);
  assert.equal(r.valuationByProduct[PID].inventoryValue, 476);
  assert.equal(adapter.issues.length, 0);
});

test('compareToRecordedCost quantifies drift vs sale_items.unit_cost', () => {
  const items = [saleItem({ id: 'si1', quantity: 25, unit_cost: '30.00' })];
  // Their snapshot says 25 x 30 = 750; true FIFO cost is 770.
  const cmp = compareToRecordedCost(items, [{ saleEventId: 'si1', cogs: 770 }]);
  assert.equal(cmp.totalRecorded, 750);
  assert.equal(cmp.totalFifo, 770);
  assert.equal(cmp.totalDifference, 20); // margin overstated by 20
  assert.equal(cmp.rows.length, 1);
});

test('opening lots seed cost basis from cost_price x stock_quantity', () => {
  const r = runLedger(openingLotsFromProducts([product({ stock_quantity: 10, cost_price: '2.50' })]));
  assert.equal(r.valuationByProduct[PID].quantityOnHand, 10);
  assert.equal(r.valuationByProduct[PID].inventoryValue, 25);
});

test('opening lots skip zero-stock products', () => {
  assert.equal(openingLotsFromProducts([product({ stock_quantity: 0 })]).length, 0);
});

test('multi-tenant filtering by business_id', () => {
  const rows = [txn({ id: 'a', business_id: 'biz-1' }), txn({ id: 'b', business_id: 'biz-2' })];
  const only = forBusiness(rows, 'biz-1');
  assert.equal(only.length, 1);
  assert.equal(only[0].id, 'a');
});

test('reconcileStock flags drift and stays quiet when it agrees', () => {
  assert.equal(reconcileStock([product({ stock_quantity: 20 })], { [PID]: { quantityOnHand: 14 } })[0].drift, -6);
  assert.equal(reconcileStock([product({ stock_quantity: 14 })], { [PID]: { quantityOnHand: 14 } }).length, 0);
});
