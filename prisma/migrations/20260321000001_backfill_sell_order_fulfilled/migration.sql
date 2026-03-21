-- Backfill: Mark all completed SELL orders as fulfilled
-- OB-003: SELL orders completed before this migration had fulfilled=false because
-- the withdrawal-webhook handler was not setting fulfilled:true on completion.
UPDATE "Orders"
SET fulfilled = true
WHERE "orderCategory" = 'SELL'
  AND status = 'done'
  AND fulfilled = false;
