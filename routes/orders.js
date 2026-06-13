const express=require('express');
const router=express.Router();
const {v4:uuidv4}=require('uuid');
const db=require('../db/connection');
const {auth,rider}=require('../middleware/auth');
const {sendSMS}=require('../middleware/sms');
const {pushNotif}=require('../middleware/helpers');

const PLACES={
  "Mzuzu City Centre":0,"Mzuzu Market":.5,"Shoprite Mzuzu":.8,"Peoples Supermarket":.6,
  "Shoppers Mall":.7,"Mzuzu Bus Depot":1.0,"Orton Chirwa Avenue":.4,"Mzuzu Post Office":.3,
  "Mzuzu Hotel":1.1,"Cityview Mall":.9,"Emfeni Lodge":1.2,"Mzuzu Police Station":.5,
  "Mzuzu District Council":.7,"Katoto":3.2,"Katoto Market":3.5,"Chibanja":4.1,
  "Chibanja Market":4.3,"Mzuzu Airport Road":5.8,"Mzimba Turn-off":6.2,"Mzuzu Airport (MZU)":7.5,
  "Luwinga":2.8,"Luwinga Market":3.0,"Mapelera":3.7,"Mapelera Market":3.9,
  "Mzuzu University":4.5,"Mzuzu Teachers College":5.0,"Mzuzu Secondary School":2.3,
  "Zolozolo":2.5,"Zolozolo Market":2.7,"Mzimu wa Anthu":3.3,
  "St John's Hospital":2.1,"Mzuzu Government Hospital":1.8,"Mzuzu Stadium":2.0,
  "Chiputula":3.0,"Chiputula Market":3.2,"Lupaso":4.8,"Nkhorongo":5.5,"Masasa":4.2
};

function calcFare(pu,dr,svc='parcel'){
  const p=PLACES[pu]??2, d=PLACES[dr]??2;
  const dist=parseFloat((Math.abs(p-d)+0.5).toFixed(1));
  let fare=Math.max(800,Math.round((800+dist*380)/50)*50);
  if(svc==='ride_along') fare=Math.round(fare*1.8/50)*50;
  if(svc==='bike_taxi')  fare=Math.round(fare*1.5/50)*50;
  return {fare,dist};
}

// FARE ESTIMATE
router.get('/estimate', auth, (req,res)=>{
  const {pickup,dropoff,service_type='parcel'}=req.query;
  if(!pickup||!dropoff) return res.status(400).json({error:'pickup and dropoff required'});
  res.json({...calcFare(pickup,dropoff,service_type),service_type});
});

// PLACE ORDER
router.post('/', auth, async (req,res)=>{
  try{
    if(req.user.role!=='client') return res.status(403).json({error:'Clients only'});
    if(req.user.status!=='active') return res.status(403).json({error:'Account not active'});
    const {pickup,dropoff,items,notes,service_type='parcel',pay_method='cash',
           tip=0,promo_code,scheduled='now',
           passenger_name,passenger_phone,passenger_emergency}=req.body;
    if(!pickup||!dropoff) return res.status(400).json({error:'pickup and dropoff required'});
    if(pickup===dropoff)  return res.status(400).json({error:'Pickup and dropoff cannot be the same'});
    let {fare,dist}=calcFare(pickup,dropoff,service_type);
    let discount=0;
    if(promo_code){
      const promo=db.prepare("SELECT * FROM promo_codes WHERE code=? AND active=1 AND (max_uses IS NULL OR used_count<max_uses)").get(promo_code.toUpperCase());
      if(promo){
        discount=promo.type==='percent'?Math.round(fare*promo.value/100):promo.value;
        db.prepare("UPDATE promo_codes SET used_count=used_count+1 WHERE code=?").run(promo_code.toUpperCase());
      }
    }
    const total=Math.max(0,fare-discount+Number(tip));
    if(pay_method==='wallet'){
      const u=db.prepare('SELECT wallet FROM users WHERE id=?').get(req.user.id);
      if((u.wallet||0)<total) return res.status(400).json({error:'Insufficient wallet balance'});
      db.prepare("UPDATE users SET wallet=wallet-? WHERE id=?").run(total,req.user.id);
      db.prepare("INSERT INTO wallet_transactions(user_id,type,amount,balance,note) SELECT ?,'deduct',?,wallet,'Order payment' FROM users WHERE id=?").run(req.user.id,total,req.user.id);
    }
    const orderId='NYM'+Date.now().toString().slice(-7);
    db.prepare("INSERT INTO orders(id,client_id,service_type,pickup,dropoff,items,notes,distance,base_fare,tip,discount,total_price,status,pay_method,scheduled,passenger_name,passenger_phone,passenger_emergency) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(orderId,req.user.id,service_type,pickup,dropoff,items||null,notes||null,dist,fare,Number(tip),discount,total,'pending',pay_method,scheduled,passenger_name||null,passenger_phone||null,passenger_emergency||null);
    db.prepare("INSERT INTO order_status_log(order_id,status,note) VALUES(?,?,'Order placed')").run(orderId,'pending');
    const pts=Math.floor(total/100);
    if(pts>0) db.prepare("UPDATE users SET loyalty_pts=loyalty_pts+? WHERE id=?").run(pts,req.user.id);
    // Notify all active riders
    const riders=db.prepare("SELECT id,phone,name FROM users WHERE role='rider' AND status='active'").all();
    for(const r of riders){
      pushNotif(r.id,'New Order Available!',`${pickup} → ${dropoff} | ${dist}km | MWK ${Math.round(total*.8).toLocaleString()} payout`,'🛵','new_order',{orderId});
      await sendSMS(r.phone,`Nyamurani: New order ${orderId}! ${pickup}→${dropoff} (${dist}km) MWK ${Math.round(total*.8).toLocaleString()} payout. Log in to accept.`);
    }
    await sendSMS(req.user.phone,`Nyamurani: Order ${orderId} placed! ${pickup}→${dropoff}. Finding your rider now.`);
    const order=db.prepare("SELECT o.*,c.name as client_name,c.phone as client_phone FROM orders o JOIN users c ON o.client_id=c.id WHERE o.id=?").get(orderId);
    res.status(201).json({order});
  }catch(e){ console.error('Order:',e); res.status(500).json({error:'Server error'}); }
});

// MY ORDERS (client)
router.get('/my', auth, (req,res)=>{
  const {status,limit=30,offset=0}=req.query;
  let q="SELECT o.*,u.name as rider_name,u.phone as rider_phone FROM orders o LEFT JOIN users u ON o.rider_id=u.id WHERE o.client_id=?";
  const p=[req.user.id];
  if(status){q+=' AND o.status=?';p.push(status);}
  q+=' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  p.push(Number(limit),Number(offset));
  res.json({orders:db.prepare(q).all(...p)});
});

// AVAILABLE ORDERS (rider)
router.get('/available', auth, rider, (req,res)=>{
  if(req.user.status!=='active') return res.status(403).json({error:'Account not active'});
  const orders=db.prepare("SELECT o.*,u.name as client_name,u.phone as client_phone FROM orders o JOIN users u ON o.client_id=u.id WHERE o.status='pending' AND o.rider_id IS NULL ORDER BY o.created_at DESC").all();
  res.json({orders});
});

// ACCEPT ORDER (rider)
router.post('/:id/accept', auth, rider, async (req,res)=>{
  try{
    if(req.user.status!=='active') return res.status(403).json({error:'Account not active'});
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if(!order) return res.status(404).json({error:'Order not found'});
    if(order.status!=='pending') return res.status(409).json({error:'Order no longer available'});
    if(order.rider_id) return res.status(409).json({error:'Order already taken'});
    db.prepare("UPDATE orders SET rider_id=?,status='accepted',updated_at=datetime('now') WHERE id=?").run(req.user.id,order.id);
    db.prepare("INSERT INTO order_status_log(order_id,status,note) VALUES(?,?,'Rider accepted')").run(order.id,'accepted');
    const client=db.prepare('SELECT name,phone FROM users WHERE id=?').get(order.client_id);
    pushNotif(order.client_id,'Rider Assigned!',`${req.user.name} accepted your order and is heading to pickup.`,'🚴','order_update',{orderId:order.id});
    await sendSMS(client.phone,`Nyamurani: Rider ${req.user.name} accepted order ${order.id}! Heading to pickup now.`);
    const updated=db.prepare("SELECT o.*,u.name as rider_name,u.phone as rider_phone FROM orders o LEFT JOIN users u ON o.rider_id=u.id WHERE o.id=?").get(order.id);
    res.json({order:updated});
  }catch(e){ res.status(500).json({error:'Server error'}); }
});

// UPDATE STATUS (rider)
router.put('/:id/status', auth, async (req,res)=>{
  try{
    const {status}=req.body;
    const valid=['arrived','pickedup','in-transit','delivered','cancelled'];
    if(!valid.includes(status)) return res.status(400).json({error:'Invalid status'});
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if(!order) return res.status(404).json({error:'Not found'});
    if(req.user.role!=='admin'&&order.rider_id!==req.user.id) return res.status(403).json({error:'Not your order'});
    db.prepare("UPDATE orders SET status=?,updated_at=datetime('now') WHERE id=?").run(status,order.id);
    db.prepare("INSERT INTO order_status_log(order_id,status) VALUES(?,?)").run(order.id,status);
    const msgs={arrived:'Rider arrived at pickup.',pickedup:'Rider picked up your order!','in-transit':'Your order is on the way!',delivered:'Order delivered! 🎉'};
    const icons={arrived:'📍',pickedup:'📦','in-transit':'🚴',delivered:'🎉'};
    const client=db.prepare('SELECT phone FROM users WHERE id=?').get(order.client_id);
    pushNotif(order.client_id,'Order Update',msgs[status]||status,icons[status]||'📦','order_update',{orderId:order.id,status});
    await sendSMS(client.phone,`Nyamurani Order ${order.id}: ${msgs[status]||status}`);
    if(status==='delivered'&&order.rider_id){
      const rp=db.prepare('SELECT commission_rate FROM rider_profiles WHERE user_id=?').get(order.rider_id);
      const rate=((rp?.commission_rate||80)/100);
      const earn=Math.round(order.total_price*rate)+(order.tip||0);
      db.prepare("UPDATE rider_profiles SET deliveries=deliveries+1,total_earnings=total_earnings+?,total_tips=total_tips+? WHERE user_id=?").run(earn,order.tip||0,order.rider_id);
    }
    const updated=db.prepare("SELECT o.*,u.name as rider_name FROM orders o LEFT JOIN users u ON o.rider_id=u.id WHERE o.id=?").get(order.id);
    res.json({order:updated});
  }catch(e){ res.status(500).json({error:'Server error'}); }
});

// RATE ORDER
router.post('/:id/rate', auth, (req,res)=>{
  const {rating,review}=req.body;
  if(!rating||rating<1||rating>5) return res.status(400).json({error:'Rating 1-5 required'});
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!order) return res.status(404).json({error:'Not found'});
  if(order.client_id!==req.user.id) return res.status(403).json({error:'Not your order'});
  if(order.rated) return res.status(409).json({error:'Already rated'});
  if(order.status!=='delivered') return res.status(400).json({error:'Not delivered yet'});
  db.prepare("UPDATE orders SET rated=1,rating=?,review=? WHERE id=?").run(rating,review||null,order.id);
  if(order.rider_id){
    const rp=db.prepare('SELECT rating,rating_count FROM rider_profiles WHERE user_id=?').get(order.rider_id);
    const n=(rp.rating_count||0)+1;
    const nr=((rp.rating||0)*(n-1)+rating)/n;
    db.prepare("UPDATE rider_profiles SET rating=?,rating_count=? WHERE user_id=?").run(Math.round(nr*10)/10,n,order.rider_id);
  }
  res.json({message:'Rating submitted'});
});

// GET SINGLE ORDER
router.get('/:id', auth, (req,res)=>{
  const order=db.prepare("SELECT o.*,c.name as client_name,c.phone as client_phone,r.name as rider_name,r.phone as rider_phone FROM orders o JOIN users c ON o.client_id=c.id LEFT JOIN users r ON o.rider_id=r.id WHERE o.id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:'Not found'});
  if(req.user.role!=='admin'&&order.client_id!==req.user.id&&order.rider_id!==req.user.id) return res.status(403).json({error:'Access denied'});
  const history=db.prepare('SELECT * FROM order_status_log WHERE order_id=? ORDER BY created_at').all(req.params.id);
  res.json({order,history});
});

module.exports=router;
