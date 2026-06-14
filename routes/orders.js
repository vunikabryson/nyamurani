const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const db = require('../db/connection');
const { auth, rider } = require('../middleware/auth');
const { sendSMS } = require('../middleware/sms');
const { pushNotif } = require('../middleware/helpers');

// ─────────────────────────────
// SAFE FARE CALC
// ─────────────────────────────
const PLACES = {
  "Mzuzu City Centre": 0,
  "Mzuzu Market": 0.5,
  "Mzuzu Airport (MZU)": 7.5
};

function calcFare(pu, dr, svc = 'parcel') {
  const p = PLACES[pu] ?? 2;
  const d = PLACES[dr] ?? 2;

  const dist = Math.max(0.5, Math.abs(p - d) + 0.5);
  let fare = Math.max(800, Math.round((800 + dist * 380) / 50) * 50);

  if (svc === 'ride_along') fare = Math.round(fare * 1.8);
  if (svc === 'bike_taxi') fare = Math.round(fare * 1.5);

  return { fare, dist: Number(dist.toFixed(1)) };
}

// ─────────────────────────────
// FARE ESTIMATE
// ─────────────────────────────
router.get('/estimate', auth, (req, res) => {
  try {
    const { pickup, dropoff, service_type = 'parcel' } = req.query;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: 'pickup and dropoff required' });
    }

    res.json(calcFare(pickup, dropoff, service_type));

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Estimate failed' });
  }
});

// ─────────────────────────────
// PLACE ORDER
// ─────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'client')
      return res.status(403).json({ error: 'Clients only' });

    if (req.user.status !== 'active')
      return res.status(403).json({ error: 'Account not active' });

    const {
      pickup,
      dropoff,
      items,
      notes,
      service_type = 'parcel',
      pay_method = 'cash',
      tip = 0
    } = req.body;

    if (!pickup || !dropoff)
      return res.status(400).json({ error: 'Missing locations' });

    const { fare, dist } = calcFare(pickup, dropoff, service_type);

    const total = fare + Number(tip || 0);

    const orderId = 'NYM' + Date.now().toString().slice(-7);

    db.prepare(`
      INSERT INTO orders
      (id,client_id,service_type,pickup,dropoff,items,notes,
       distance,base_fare,tip,total_price,status,pay_method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orderId,
      req.user.id,
      service_type,
      pickup,
      dropoff,
      items || null,
      notes || null,
      dist,
      fare,
      Number(tip || 0),
      total,
      'pending',
      pay_method
    );

    db.prepare(
      "INSERT INTO order_status_log(order_id,status,note) VALUES(?,?,?)"
    ).run(orderId, 'pending', 'Order placed');

    // notify riders (NO await loop crash)
    const riders = db.prepare(
      "SELECT id,phone,name FROM users WHERE role='rider' AND status='active'"
    ).all();

    for (const r of riders) {
      try {
        pushNotif(r.id, 'New Order', `${pickup} → ${dropoff}`, '🛵', 'new_order', { orderId });

        sendSMS(
          r.phone,
          `New order ${orderId}: ${pickup} → ${dropoff}`
        ).catch(() => {});
      } catch (e) {
        console.error('Rider notify failed:', e.message);
      }
    }

    const order = db.prepare(
      "SELECT * FROM orders WHERE id=?"
    ).get(orderId);

    res.status(201).json({ order });

  } catch (e) {
    console.error('ORDER ERROR:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────
// AVAILABLE ORDERS
// ─────────────────────────────
router.get('/available', auth, rider, (req, res) => {
  try {
    const orders = db.prepare(
      "SELECT * FROM orders WHERE status='pending' AND rider_id IS NULL ORDER BY created_at DESC"
    ).all();

    res.json({ orders });

  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ─────────────────────────────
// ACCEPT ORDER (SAFE RACE FIX)
// ─────────────────────────────
router.post('/:id/accept', auth, rider, (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);

    if (!order)
      return res.status(404).json({ error: 'Not found' });

    if (order.status !== 'pending' || order.rider_id)
      return res.status(409).json({ error: 'Already taken' });

    db.prepare(`
      UPDATE orders
      SET rider_id=?, status='accepted', updated_at=datetime('now')
      WHERE id=? AND rider_id IS NULL
    `).run(req.user.id, order.id);

    res.json({ message: 'Accepted' });

  } catch (e) {
    res.status(500).json({ error: 'Accept failed' });
  }
});

// ─────────────────────────────
// UPDATE STATUS (SAFE)
// ─────────────────────────────
router.put('/:id/status', auth, (req, res) => {
  try {
    const { status } = req.body;

    const valid = ['arrived', 'pickedup', 'in-transit', 'delivered', 'cancelled'];
    if (!valid.includes(status))
      return res.status(400).json({ error: 'Invalid status' });

    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });

    db.prepare(`
      UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?
    `).run(status, order.id);

    db.prepare(
      "INSERT INTO order_status_log(order_id,status) VALUES(?,?)"
    ).run(order.id, status);

    res.json({ message: 'Updated' });

  } catch (e) {
    res.status(500).json({ error: 'Status update failed' });
  }
});

// ─────────────────────────────
// RATE ORDER (FIXED MATH)
// ─────────────────────────────
router.post('/:id/rate', auth, (req, res) => {
  try {
    const { rating, review } = req.body;

    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Invalid rating' });

    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);

    if (!order)
      return res.status(404).json({ error: 'Not found' });

    const prev = db.prepare(
      'SELECT rating, rating_count FROM rider_profiles WHERE user_id=?'
    ).get(order.rider_id);

    const count = (prev?.rating_count || 0) + 1;
    const newRating =
      ((prev?.rating || 0) * (count - 1) + rating) / count;

    db.prepare(`
      UPDATE rider_profiles
      SET rating=?, rating_count=?
      WHERE user_id=?
    `).run(Number(newRating.toFixed(1)), count, order.rider_id);

    res.json({ message: 'Rated' });

  } catch (e) {
    res.status(500).json({ error: 'Rating failed' });
  }
});

// ─────────────────────────────
// GET ORDER
// ─────────────────────────────
router.get('/:id', auth, (req, res) => {
  try {
    const order = db.prepare(
      "SELECT * FROM orders WHERE id=?"
    ).get(req.params.id);

    if (!order)
      return res.status(404).json({ error: 'Not found' });

    res.json({ order });

  } catch (e) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

module.exports = router;
