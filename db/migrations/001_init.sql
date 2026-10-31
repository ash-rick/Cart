-- Schema for the checkout & rewards service.
-- Constraints are named after what they protect so a violation in a log points at
-- the invariant (I1..I8 in CLAUDE.md) it backs up.

CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents BIGINT NOT NULL CONSTRAINT products_price_nonnegative CHECK (price_cents >= 0),
  -- I1: the last line of defence against overselling.
  stock       INT NOT NULL CONSTRAINT products_stock_nonnegative CHECK (stock >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE carts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status         TEXT NOT NULL DEFAULT 'OPEN'
                 CONSTRAINT carts_status_valid CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_out_at TIMESTAMPTZ NULL,
  CONSTRAINT carts_checked_out_at_matches_status
    CHECK ((status = 'CHECKED_OUT') = (checked_out_at IS NOT NULL))
);

CREATE TABLE cart_items (
  cart_id    UUID NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products (id),
  quantity   INT NOT NULL CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE coupons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL CONSTRAINT coupons_code_unique UNIQUE,
  -- I5: at most one coupon per milestone, even under concurrent admin calls.
  milestone   INT NOT NULL CONSTRAINT coupons_milestone_unique UNIQUE
              CONSTRAINT coupons_milestone_positive CHECK (milestone > 0),
  percent     INT NOT NULL CONSTRAINT coupons_percent_range CHECK (percent BETWEEN 1 AND 100),
  status      TEXT NOT NULL DEFAULT 'AVAILABLE'
              CONSTRAINT coupons_status_valid CHECK (status IN ('AVAILABLE', 'REDEEMED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_at TIMESTAMPTZ NULL,
  CONSTRAINT coupons_redeemed_at_matches_status
    CHECK ((status = 'REDEEMED') = (redeemed_at IS NOT NULL))
);

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- I2: one order per cart. Also the idempotency anchor for checkout retries (I3).
  cart_id             UUID NOT NULL CONSTRAINT orders_cart_id_unique UNIQUE REFERENCES carts (id),
  subtotal_cents      BIGINT NOT NULL CONSTRAINT orders_subtotal_nonnegative CHECK (subtotal_cents >= 0),
  discount_cents      BIGINT NOT NULL CONSTRAINT orders_discount_nonnegative CHECK (discount_cents >= 0),
  total_cents         BIGINT NOT NULL CONSTRAINT orders_total_nonnegative CHECK (total_cents >= 0),
  -- I4: a coupon is attached to at most one order.
  coupon_id           UUID NULL CONSTRAINT orders_coupon_id_unique UNIQUE REFERENCES coupons (id),
  coupon_code         TEXT NULL,
  discount_percent    INT NULL,
  request_fingerprint TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- I6: totals reconcile.
  CONSTRAINT orders_total_is_subtotal_minus_discount CHECK (total_cents = subtotal_cents - discount_cents),
  CONSTRAINT orders_discount_within_subtotal CHECK (discount_cents <= subtotal_cents),
  -- The coupon snapshot is all-or-nothing.
  CONSTRAINT orders_coupon_snapshot_complete CHECK (
    (coupon_id IS NULL AND coupon_code IS NULL AND discount_percent IS NULL AND discount_cents = 0)
    OR (coupon_id IS NOT NULL AND coupon_code IS NOT NULL AND discount_percent BETWEEN 1 AND 100)
  )
);

-- I7: snapshot of what was bought and at what price. Never joined back to products for display.
CREATE TABLE order_lines (
  order_id         UUID NOT NULL REFERENCES orders (id),
  product_id       TEXT NOT NULL REFERENCES products (id),
  product_name     TEXT NOT NULL,
  unit_price_cents BIGINT NOT NULL CONSTRAINT order_lines_unit_price_nonnegative CHECK (unit_price_cents >= 0),
  quantity         INT NOT NULL CONSTRAINT order_lines_quantity_positive CHECK (quantity > 0),
  line_total_cents BIGINT NOT NULL,
  CONSTRAINT order_lines_line_total_matches CHECK (line_total_cents = unit_price_cents * quantity),
  PRIMARY KEY (order_id, product_id)
);

-- No extra indexes: every lookup is by a PK or a UNIQUE column, and
-- cart_items(cart_id) / order_lines(order_id) are covered by their composite PKs.
