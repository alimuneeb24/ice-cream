-- Seed data. Run once after schema.sql (npm run db:init), or via npm run db:reset.

-- The 14 ice creams owed before this website existed. The fixed old timestamp
-- (1760000000000) means this event never triggers the +2 cooldown.
INSERT INTO events (type, qty, by, note, flavour, shop_id, created_at)
VALUES ('owe', 14, 'system', 'The Archives — ice creams from before this website existed', NULL, NULL, 1760000000000);

-- SHOPS
-- Real branches near Gulshan / Johar / Bahadurabad. Coordinates are the shops'
-- own foodpanda / OpenStreetMap pins, not guesses.
INSERT INTO shops (name, area, address, lat, lng, note, visited, is_next, added_by, created_at) VALUES
  ('Sweet Creme', 'Gulshan-e-Iqbal Block 4', 'Lucky Centre, Allama Shabbir Ahmed Usmani Rd', 24.9302097, 67.0985335, NULL, 0, 0, 'system', 1760000000000),
  ('Soft Swirl', 'Gulshan-e-Iqbal Block 4', 'Sumera Square, Allama Shabbir Ahmed Usmani Rd', 24.9313719, 67.1000183, NULL, 0, 0, 'system', 1760000000000),
  ('Baskin Robbins', 'Bahadurabad', 'Plot 31, Block 3, Alamgir Rd, Bahadurabad', 24.8826492, 67.0671215, NULL, 0, 0, 'system', 1760000000000),
  ('Iceberg', 'Gulistan-e-Johar Block 18', 'Billy''s Heights, Block 18, near Johar Mor', 24.9099592, 67.123048, NULL, 0, 0, 'system', 1760000000000),
  ('Peshawari Ice Cream', 'Bahadurabad', 'Bahadur Shah Zafar Road, 4 Minar Chowrangi', 24.8827605, 67.0677891, NULL, 0, 1, 'system', 1760000000000);
