require('dotenv').config();
const db = require('./connection');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

console.log('Setting up database...');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL, password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('client','rider','admin')),
    status TEXT NOT NULL DEFAULT 'waiting',
    photo TEXT, id_number TEXT, area TEXT,
    wallet REAL NOT NULL DEFAULT 0, loyalty_pts INTEGER NOT NULL DEFAULT 0,
    saved_addresses TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rider_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bike_model TEXT, plate_number TEXT, license_number TEXT,
    id_number TEXT, emergency_name TEXT, emergency_phone TEXT,
    contract_signed INTEGER NOT NULL DEFAULT 0, contract_date TEXT,
    ride_along_enabled INTEGER NOT NULL DEFAULT 1,
    rating REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0,
    deliveries INTEGER NOT NULL DEFAULT 0, cancellations INTEGER NOT NULL DEFAULT 0,
    total_earnings REAL NOT NULL DEFAULT 0, total_tips REAL NOT NULL DEFAULT 0,
    commission_rate REAL NOT NULL DEFAULT 80
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id),
    rider_id TEXT REFERENCES users(id),
    service_type TEXT NOT NULL DEFAULT 'parcel',
    pickup TEXT NOT NULL, dropoff TEXT NOT NULL,
    items TEXT, notes TEXT,
    distance REAL NOT NULL DEFAULT 0, base_fare REAL NOT NULL DEFAULT 0,
    tip REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0,
    total_price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    pay_method TEXT NOT NULL DEFAULT 'cash',
    scheduled TEXT DEFAULT 'now',
    rated INTEGER NOT NULL DEFAULT 0, rating INTEGER, review TEXT, proof_photo TEXT,
    passenger_name TEXT, passenger_phone TEXT, passenger_emergency TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, message TEXT NOT NULL, icon TEXT DEFAULT '🔔',
    type TEXT DEFAULT 'info', read_flag INTEGER NOT NULL DEFAULT 0,
    data TEXT DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, message TEXT NOT NULL,
    status TEXT DEFAULT 'sent', provider TEXT DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id TEXT NOT NULL, admin_name TEXT NOT NULL,
    action TEXT NOT NULL, target_id TEXT, target_name TEXT, target_role TEXT,
    reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY, rider_id TEXT NOT NULL REFERENCES users(id),
    amount REAL NOT NULL, period_start TEXT, period_end TEXT,
    status TEXT NOT NULL DEFAULT 'pending', payment_ref TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY, type TEXT NOT NULL, value REAL NOT NULL,
    max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL, amount REAL NOT NULL, balance REAL NOT NULL,
    ref TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id),
    order_id TEXT REFERENCES orders(id), type TEXT NOT NULL,
    description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    response TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_client  ON orders(client_id);
  CREATE INDEX IF NOT EXISTS idx_orders_rider   ON orders(rider_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_notifs_user    ON notifications(user_id, read_flag);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_payouts_rider  ON payouts(rider_id, status);
`);

const adminEmail = process.env.ADMIN_EMAIL || 'admin@nyamurani.mw';
const adminPass  = process.env.ADMIN_PASSWORD || 'Nyam@2025!';
const adminPhone = process.env.ADMIN_PHONE || '+265999000000';

if (!db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) {
  const hash = bcrypt.hashSync(adminPass, 12);
  db.prepare("INSERT INTO users(id,name,email,phone,password,role,status) VALUES(?,'Nyamurani Admin',?,?,?,'admin','active')")
    .run(uuidv4(), adminEmail, adminPhone, hash);
  console.log('Admin seeded:', adminEmail);
} else {
  console.log('Admin already exists');
}

[['WELCOME20','percent',20,1000],['MZUZU10','flat',100,500],['NYAMURANI','percent',15,null]]
  .forEach(p => db.prepare('INSERT OR IGNORE INTO promo_codes(code,type,value,max_uses) VALUES(?,?,?,?)').run(...p));

console.log('Database ready!');
