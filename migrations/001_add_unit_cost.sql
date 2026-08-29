-- Ursella — add a cost basis to inventory_transactions.
--
-- WHY THIS MATTERS
--
-- inventory_transactions records HOW MANY units moved, but not WHAT THEY COST.
-- Without a cost on each stock-in, there is no way to know that the 20 bags you
-- received in January cost 30 and the 20 you received in March cost 34. Cost of
-- goods sold then has to fall back to a single current products.cost_price,
-- which silently misstates margin every time a supplier price changes.
--
-- This migration is additive and safe:
--   * the column is NULLABLE, so existing rows and existing inserts still work
--   * nothing is rewritten or deleted
--   * the engine already reads unit_cost when present and falls back to
--     products.cost_price when it is NULL, so you can adopt it gradually
--
-- Run it in the Supabase SQL editor. Review before running, as with any migration.

alter table public.inventory_transactions
  add column if not exists unit_cost numeric;

comment on column public.inventory_transactions.unit_cost is
  'Per-unit cost for stock-in rows (purchases/receipts/positive adjustments). '
  'NULL for outbound rows and for historical rows recorded before this column existed. '
  'Populated going forward so FIFO cost lots are exact.';

-- Optional: backfill history with the current cost so old rows have some basis.
-- This is an APPROXIMATION — it applies today's cost to past receipts. It is
-- better than zero, and worse than the truth. Uncomment only if you want it.
--
-- update public.inventory_transactions it
--    set unit_cost = p.cost_price
--   from public.products p
--  where it.product_id = p.id
--    and it.unit_cost is null;

-- Going forward, set unit_cost on every stock-in write:
--
--   insert into inventory_transactions
--     (business_id, product_id, transaction_type, quantity, unit_cost, notes)
--   values
--     (:business_id, :product_id, 'purchase', :quantity, :unit_cost, :notes);
--
-- Once that is in place the FIFO engine is exact, and products.cost_price
-- becomes a display convenience rather than the source of financial truth.
