const express=require('express');
const router=express.Router();
const {v4:uuidv4}=require('uuid');
const db=require('../db/connection');
const {auth,rider}=require('../middleware/auth');
const {sendSMS}=require('../middleware/sms');
const {pushNotif}=require('../middleware/helpers');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const uploadDir=process.env.UPLOAD_DIR||'./uploads';
if(!fs.existsSync(uploadDir))fs.mkdirSync(uploadDir,{recursive:true});
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,uploadDir),filename:(req,file,cb)=>cb(null,`${req.user.id}_${Date.now()}${path.extname(file.originalname)}`)});
const upload=multer({storage,limits:{fileSize:3*1024*1024}});
router.use(auth);
router.get('/earnings',rider,(req,res)=>{
  const profile=db.prepare('SELECT * FROM rider_profiles WHERE user_id=?').get(req.user.id);
  const rate=((profile?.commission_rate||80)/100);
  const calc=rows=>rows.map(r=>({...r,rider_earnings:Math.round(r.gross*rate),platform_fee:Math.round(r.gross*(1-rate))}));
  const totals=db.prepare("SELECT COUNT(*) total_deliveries,COALESCE(SUM(total_price),0) gross_revenue,COALESCE(SUM(tip),0) total_tips FROM orders WHERE rider_id=? AND status='delivered'").get(req.user.id);
  const thisWeek=db.prepare("SELECT COUNT(*) cnt FROM orders WHERE rider_id=? AND status='delivered' AND created_at>=date('now','weekday 0','-7 days')").get(req.user.id).cnt;
  res.json({
    profile,
    daily:  calc(db.prepare("SELECT date(created_at) day,COUNT(*) deliveries,COALESCE(SUM(total_price),0) gross,COALESCE(SUM(tip),0) tips FROM orders WHERE rider_id=? AND status='delivered' GROUP BY day ORDER BY day DESC LIMIT 30").all(req.user.id)),
    weekly: calc(db.prepare("SELECT strftime('%Y-W%W',created_at) week,COUNT(*) deliveries,COALESCE(SUM(total_price),0) gross,COALESCE(SUM(tip),0) tips FROM orders WHERE rider_id=? AND status='delivered' GROUP BY week ORDER BY week DESC LIMIT 12").all(req.user.id)),
    monthly:calc(db.prepare("SELECT strftime('%Y-%m',created_at) month,COUNT(*) deliveries,COALESCE(SUM(total_price),0) gross,COALESCE(SUM(tip),0) tips FROM orders WHERE rider_id=? AND status='delivered' GROUP BY month ORDER BY month DESC LIMIT 12").all(req.user.id)),
    totals:{...totals,rider_earnings:Math.round(totals.gross_revenue*rate),platform_fee:Math.round(totals.gross_revenue*(1-rate))},
    payouts:db.prepare("SELECT * FROM payouts WHERE rider_id=? ORDER BY created_at DESC LIMIT 20").all(req.user.id),
    weeklyBonus:thisWeek>=10?2000:thisWeek>=7?1000:0,
    thisWeek
  });
});
router.post('/withdrawal',rider,async(req,res)=>{
  const {amount,phone_number}=req.body;
  if(!amount||amount<500) return res.status(400).json({error:'Minimum MWK 500'});
  const id=uuidv4();
  db.prepare('INSERT INTO payouts(id,rider_id,amount,notes) VALUES(?,?,?,?)').run(id,req.user.id,amount,`Withdrawal to ${phone_number||req.user.phone}`);
  const adminUser=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if(adminUser) pushNotif(adminUser.id,'Withdrawal Request',`Rider ${req.user.name} requested MWK ${Number(amount).toLocaleString()} withdrawal.`,'💰','withdrawal');
  await sendSMS(req.user.phone,`Nyamurani: Withdrawal of MWK ${Number(amount).toLocaleString()} requested. Processing within 24 hours.`);
  res.status(201).json({message:'Requested',id});
});
router.post('/photo',upload.single('photo'),(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  const photo=`/uploads/${req.file.filename}`;
  db.prepare("UPDATE users SET photo=? WHERE id=?").run(photo,req.user.id);
  res.json({photo});
});
router.post('/orders/:orderId/proof',rider,upload.single('photo'),(req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=? AND rider_id=?').get(req.params.orderId,req.user.id);
  if(!o) return res.status(404).json({error:'Not found'});
  const photo=req.file?`/uploads/${req.file.filename}`:null;
  db.prepare("UPDATE orders SET proof_photo=? WHERE id=?").run(photo,o.id);
  res.json({photo});
});
module.exports=router;
