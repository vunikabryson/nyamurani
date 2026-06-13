const express=require('express');
const router=express.Router();
const {v4:uuidv4}=require('uuid');
const db=require('../db/connection');
const {auth,admin}=require('../middleware/auth');
const {sendSMS}=require('../middleware/sms');
const {safe,pushNotif,audit}=require('../middleware/helpers');

router.use(auth,admin);

// OVERVIEW
router.get('/overview',(req,res)=>{
  const r={
    totalOrders:   db.prepare("SELECT COUNT(*) c FROM orders").get().c,
    delivered:     db.prepare("SELECT COUNT(*) c FROM orders WHERE status='delivered'").get().c,
    pending:       db.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").get().c,
    inTransit:     db.prepare("SELECT COUNT(*) c FROM orders WHERE status='in-transit'").get().c,
    cancelled:     db.prepare("SELECT COUNT(*) c FROM orders WHERE status='cancelled'").get().c,
    revenue:       db.prepare("SELECT COALESCE(SUM(total_price),0) r FROM orders WHERE status='delivered'").get().r,
    totalRiders:   db.prepare("SELECT COUNT(*) c FROM users WHERE role='rider'").get().c,
    activeRiders:  db.prepare("SELECT COUNT(*) c FROM users WHERE role='rider' AND status='active'").get().c,
    totalClients:  db.prepare("SELECT COUNT(*) c FROM users WHERE role='client'").get().c,
    waitingApproval:db.prepare("SELECT COUNT(*) c FROM users WHERE status='waiting'").get().c,
    recentOrders:  db.prepare("SELECT o.*,c.name client_name,r.name rider_name FROM orders o JOIN users c ON o.client_id=c.id LEFT JOIN users r ON o.rider_id=r.id ORDER BY o.created_at DESC LIMIT 6").all(),
    recentRegs:    db.prepare("SELECT id,name,email,phone,role,status,created_at FROM users WHERE status='waiting' ORDER BY created_at DESC LIMIT 20").all(),
  };
  res.json(r);
});

// LIST USERS
router.get('/users',(req,res)=>{
  const {role,status,limit=100,offset=0}=req.query;
  let q="SELECT u.*,rp.bike_model,rp.plate_number,rp.rating,rp.deliveries,rp.total_earnings,rp.commission_rate FROM users u LEFT JOIN rider_profiles rp ON u.id=rp.user_id WHERE u.role!='admin'";
  const p=[];
  if(role){q+=' AND u.role=?';p.push(role);}
  if(status){q+=' AND u.status=?';p.push(status);}
  q+=' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
  p.push(Number(limit),Number(offset));
  const users=db.prepare(q).all(...p).map(safe);
  res.json({users,total:db.prepare("SELECT COUNT(*) c FROM users WHERE role!='admin'").get().c});
});

// USER PROFILE
router.get('/users/:id',(req,res)=>{
  const u=db.prepare("SELECT u.*,rp.* FROM users u LEFT JOIN rider_profiles rp ON u.id=rp.user_id WHERE u.id=?").get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  const orders=db.prepare("SELECT COUNT(*) cnt,COALESCE(SUM(total_price),0) spent FROM orders WHERE client_id=? OR rider_id=?").get(u.id,u.id);
  res.json({user:safe(u),orders});
});

// APPROVE
router.post('/users/:id/approve',async(req,res)=>{
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE users SET status='active',updated_at=datetime('now') WHERE id=?").run(u.id);
  audit(req.user.id,req.user.name,'approved',u.id,u.name,u.role);
  pushNotif(u.id,'Account Approved!',`Your ${u.role} account is approved! Log in now.`,'✅','approval');
  await sendSMS(u.phone,`[NYAMURANI] Hi ${u.name.split(' ')[0]}! Your ${u.role} account is APPROVED. Log in to get started!`);
  res.json({message:'Approved'});
});

// REJECT
router.post('/users/:id/reject',async(req,res)=>{
  const {reason=''}=req.body;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE users SET status='suspended',updated_at=datetime('now') WHERE id=?").run(u.id);
  audit(req.user.id,req.user.name,'rejected',u.id,u.name,u.role,reason);
  pushNotif(u.id,'Registration Not Approved',`Your ${u.role} registration was not approved.${reason?' Reason: '+reason:''}`,'❌','rejection');
  await sendSMS(u.phone,`[NYAMURANI] Hi ${u.name.split(' ')[0]}, your ${u.role} registration was not approved.${reason?' Reason: '+reason:''} Contact admin@nyamurani.mw`);
  res.json({message:'Rejected'});
});

// SUSPEND
router.post('/users/:id/suspend',async(req,res)=>{
  const {reason=''}=req.body;
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE users SET status='suspended',updated_at=datetime('now') WHERE id=?").run(u.id);
  audit(req.user.id,req.user.name,'suspended',u.id,u.name,u.role,reason);
  pushNotif(u.id,'Account Suspended',`Your account has been suspended.${reason?' Reason: '+reason:''}`,'⏸','suspension');
  await sendSMS(u.phone,`[NYAMURANI] Your account has been suspended.${reason?' Reason: '+reason:''} Contact admin@nyamurani.mw`);
  res.json({message:'Suspended'});
});

// RESTORE
router.post('/users/:id/restore',async(req,res)=>{
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE users SET status='active',updated_at=datetime('now') WHERE id=?").run(u.id);
  audit(req.user.id,req.user.name,'restored',u.id,u.name,u.role);
  pushNotif(u.id,'Account Reactivated!','Your account has been reactivated. Welcome back!','▶','reactivation');
  await sendSMS(u.phone,`[NYAMURANI] Hi ${u.name.split(' ')[0]}! Your account is reactivated. Welcome back!`);
  res.json({message:'Restored'});
});

// DELETE
router.delete('/users/:id',async(req,res)=>{
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  audit(req.user.id,req.user.name,'deleted',u.id,u.name,u.role);
  await sendSMS(u.phone,'[NYAMURANI] Your account has been removed. Contact admin@nyamurani.mw if this is an error.');
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({message:'Deleted'});
});

// NOTIFY USER
router.post('/users/:id/notify',async(req,res)=>{
  const {message}=req.body;
  if(!message) return res.status(400).json({error:'Message required'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if(!u) return res.status(404).json({error:'Not found'});
  audit(req.user.id,req.user.name,'notified',u.id,u.name,u.role,message.slice(0,60));
  pushNotif(u.id,'Message from Admin',message,'📩','admin_message');
  await sendSMS(u.phone,`[NYAMURANI Admin] ${message}`);
  res.json({message:'Sent'});
});

// ALL ORDERS
router.get('/orders',(req,res)=>{
  const {status,limit=100,offset=0}=req.query;
  let q="SELECT o.*,c.name client_name,c.phone client_phone,r.name rider_name,r.phone rider_phone FROM orders o JOIN users c ON o.client_id=c.id LEFT JOIN users r ON o.rider_id=r.id";
  const p=[];
  if(status){q+=' WHERE o.status=?';p.push(status);}
  q+=' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  p.push(Number(limit),Number(offset));
  res.json({orders:db.prepare(q).all(...p),total:db.prepare("SELECT COUNT(*) c FROM orders").get().c});
});

router.put('/orders/:id/status',(req,res)=>{
  const {status}=req.body;
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o) return res.status(404).json({error:'Not found'});
  db.prepare("UPDATE orders SET status=?,updated_at=datetime('now') WHERE id=?").run(status,o.id);
  db.prepare('INSERT INTO order_status_log(order_id,status,note) VALUES(?,?,?)').run(o.id,status,'Admin updated');
  audit(req.user.id,req.user.name,'order_update',o.id,o.id,'order',status);
  res.json({message:'Updated'});
});

router.delete('/orders/:id',(req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o) return res.status(404).json({error:'Not found'});
  audit(req.user.id,req.user.name,'order_deleted',o.id,o.id,'order');
  db.prepare('DELETE FROM orders WHERE id=?').run(o.id);
  res.json({message:'Deleted'});
});

// RIDER PERFORMANCE
router.get('/riders/performance',(req,res)=>{
  const riders=db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.status,u.photo,rp.bike_model,rp.plate_number,rp.rating,rp.rating_count,rp.deliveries,rp.total_earnings,rp.total_tips,rp.commission_rate,(SELECT COUNT(*) FROM orders WHERE rider_id=u.id AND status='delivered') completed,(SELECT COALESCE(SUM(total_price),0) FROM orders WHERE rider_id=u.id AND status='delivered') gross_revenue,(SELECT COALESCE(AVG(rating),0) FROM orders WHERE rider_id=u.id AND rated=1) avg_rating FROM users u JOIN rider_profiles rp ON u.id=rp.user_id ORDER BY completed DESC`).all();
  res.json({riders:riders.map(r=>({...r,rider_earnings:Math.round(r.gross_revenue*(r.commission_rate||80)/100),platform_fee:Math.round(r.gross_revenue*(100-(r.commission_rate||80))/100)}))});
});

// LEADERBOARD
router.get('/riders/leaderboard',(req,res)=>{
  const {sort='deliveries',limit=10}=req.query;
  const cols={deliveries:'completed',revenue:'gross_revenue',rating:'avg_rating'};
  const col=cols[sort]||'completed';
  const riders=db.prepare(`SELECT u.id,u.name,u.photo,rp.rating,rp.deliveries,(SELECT COUNT(*) FROM orders WHERE rider_id=u.id AND status='delivered') completed,(SELECT COALESCE(SUM(total_price),0) FROM orders WHERE rider_id=u.id AND status='delivered') gross_revenue,(SELECT COALESCE(AVG(rating),0) FROM orders WHERE rider_id=u.id AND rated=1) avg_rating FROM users u JOIN rider_profiles rp ON u.id=rp.user_id WHERE u.status='active' ORDER BY ${col} DESC LIMIT ?`).all(Number(limit));
  res.json({leaderboard:riders,sort});
});

// EARNINGS REPORT
router.get('/reports/earnings',(req,res)=>{
  const {period='daily',rider_id}=req.query;
  const g=period==='monthly'?"strftime('%Y-%m',created_at)":period==='weekly'?"strftime('%Y-W%W',created_at)":"date(created_at)";
  let q=`SELECT ${g} period,COUNT(*) deliveries,COALESCE(SUM(total_price),0) gross_revenue,COALESCE(SUM(tip),0) tips,COALESCE(SUM(total_price*0.8),0) rider_earnings,COALESCE(SUM(total_price*0.2),0) platform_revenue FROM orders WHERE status='delivered'`;
  const p=[];
  if(rider_id){q+=' AND rider_id=?';p.push(rider_id);}
  q+=` GROUP BY ${g} ORDER BY period DESC LIMIT 60`;
  res.json({period,report:db.prepare(q).all(...p),totals:db.prepare("SELECT COALESCE(SUM(total_price),0) total,COUNT(*) count FROM orders WHERE status='delivered'"+(rider_id?' AND rider_id=?':'')).get(...(rider_id?[rider_id]:[]))});
});

// PAYOUTS
router.get('/payouts',(req,res)=>{
  const {status,rider_id}=req.query;
  let q="SELECT p.*,u.name rider_name,u.phone rider_phone FROM payouts p JOIN users u ON p.rider_id=u.id";
  const w=[],p=[];
  if(status){w.push('p.status=?');p.push(status);}
  if(rider_id){w.push('p.rider_id=?');p.push(rider_id);}
  if(w.length)q+=' WHERE '+w.join(' AND ');
  q+=' ORDER BY p.created_at DESC LIMIT 100';
  res.json({payouts:db.prepare(q).all(...p)});
});
router.post('/payouts',async(req,res)=>{
  const {rider_id,amount,period_start,period_end,notes}=req.body;
  if(!rider_id||!amount) return res.status(400).json({error:'rider_id and amount required'});
  const rider=db.prepare("SELECT * FROM users WHERE id=? AND role='rider'").get(rider_id);
  if(!rider) return res.status(404).json({error:'Rider not found'});
  const id=uuidv4();
  db.prepare('INSERT INTO payouts(id,rider_id,amount,period_start,period_end,notes) VALUES(?,?,?,?,?,?)').run(id,rider_id,amount,period_start||null,period_end||null,notes||null);
  audit(req.user.id,req.user.name,'payout_created',rider_id,rider.name,'rider',`MWK ${amount}`);
  pushNotif(rider_id,'Payout Initiated',`MWK ${Number(amount).toLocaleString()} payout initiated.`,'💰','payout');
  await sendSMS(rider.phone,`[NYAMURANI] Payout of MWK ${Number(amount).toLocaleString()} initiated! You will receive it on your mobile money shortly.`);
  res.status(201).json({payout:db.prepare('SELECT * FROM payouts WHERE id=?').get(id)});
});
router.put('/payouts/:id',(req,res)=>{
  const {status,payment_ref}=req.body;
  db.prepare("UPDATE payouts SET status=?,payment_ref=?,updated_at=datetime('now') WHERE id=?").run(status,payment_ref||null,req.params.id);
  res.json({message:'Updated'});
});

// AUDIT LOG
router.get('/audit',(req,res)=>{
  const {action,limit=100,offset=0}=req.query;
  let q='SELECT * FROM audit_log';
  const p=[];
  if(action){q+=' WHERE action=?';p.push(action);}
  q+=' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  p.push(Number(limit),Number(offset));
  res.json({logs:db.prepare(q).all(...p)});
});

// ANALYTICS
router.get('/analytics',(req,res)=>{
  res.json({
    peakHours: db.prepare("SELECT strftime('%H',created_at) hour,COUNT(*) count FROM orders WHERE status='delivered' GROUP BY hour ORDER BY hour").all(),
    byZone:    db.prepare("SELECT dropoff location,COUNT(*) count FROM orders GROUP BY dropoff ORDER BY count DESC LIMIT 10").all(),
    byService: db.prepare("SELECT service_type,COUNT(*) count,COALESCE(SUM(total_price),0) revenue FROM orders GROUP BY service_type").all(),
    weekly:    db.prepare("SELECT strftime('%Y-W%W',created_at) week,COALESCE(SUM(total_price),0) revenue,COUNT(*) orders FROM orders WHERE status='delivered' GROUP BY week ORDER BY week DESC LIMIT 8").all(),
  });
});

// SMS LOG
router.get('/sms',(req,res)=>res.json({logs:db.prepare('SELECT * FROM sms_log ORDER BY created_at DESC LIMIT 200').all()}));

// PROMOS
router.get('/promos',(req,res)=>res.json({promos:db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all()}));
router.post('/promos',(req,res)=>{
  const {code,type,value,max_uses,expires_at}=req.body;
  if(!code||!type||!value) return res.status(400).json({error:'code,type,value required'});
  db.prepare('INSERT OR REPLACE INTO promo_codes(code,type,value,max_uses,expires_at) VALUES(?,?,?,?,?)').run(code.toUpperCase(),type,value,max_uses||null,expires_at||null);
  res.status(201).json({message:'Created'});
});

// EVENTS (cross-device polling)
router.get('/events',(req,res)=>{
  const {since=0}=req.query;
  const sinceDate=new Date(Number(since)).toISOString();
  const events=db.prepare("SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC LIMIT 50").all(sinceDate);
  res.json({events,serverTime:Date.now()});
});

// SUPPORT TICKETS
router.get('/tickets',(req,res)=>res.json({tickets:db.prepare("SELECT t.*,u.name user_name,u.phone user_phone FROM support_tickets t LEFT JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC LIMIT 100").all()}));
router.put('/tickets/:id',(req,res)=>{
  const {status,response}=req.body;
  db.prepare("UPDATE support_tickets SET status=?,response=?,updated_at=datetime('now') WHERE id=?").run(status,response||null,req.params.id);
  res.json({message:'Updated'});
});

// COMMISSION
router.put('/riders/:id/commission',(req,res)=>{
  const {commission_rate}=req.body;
  if(!commission_rate||commission_rate<0||commission_rate>100) return res.status(400).json({error:'0-100 required'});
  db.prepare('UPDATE rider_profiles SET commission_rate=? WHERE user_id=?').run(commission_rate,req.params.id);
  audit(req.user.id,req.user.name,'commission_updated',req.params.id,req.params.id,'rider',commission_rate+'%');
  res.json({message:'Updated'});
});

module.exports=router;
