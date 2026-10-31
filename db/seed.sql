-- Awkward prices are deliberate: they exercise floor rounding on percent discounts.
-- sku_print has stock 3 so oversell races are easy to provoke.
INSERT INTO products (id, name, price_cents, stock) VALUES
  ('sku_tee',     'Classic Tee',           2500,  100),
  ('sku_mug',     'Ceramic Mug',           1299,   50),
  ('sku_hoodie',  'Zip Hoodie',            5999,   25),
  ('sku_cap',     'Logo Cap',              1999,   40),
  ('sku_sticker', 'Sticker Pack',           199, 1000),
  ('sku_print',   'Limited Edition Print', 4999,    3);
