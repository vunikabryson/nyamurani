const express=require('express');
const router=express.Router();
const bcrypt=require('bcryptjs');
const {v4:uuidv4}=require('uuid');
const db=require('../db/connection');
const {auth}=require('../middleware/auth');
const {sendSMS}=require('../middleware/sms');
const {safe,makeToken,pushNotif}=require('../middleware/helpers');

// REGISTER
router.post('/register', async (req,res)=>{
  try{
    const {name,email,phone,password,role,id_number,
           bike_model,plate_number,license_number,
           emergency_name,emergency_phone,contract_signed}=req.body;
    if(!name||!email||!phone||!password||!role)
      return res.status(400).json({error:'Missing required fields'});
    if(!['client','rider'].includes(role))
      return res.status(400).json({error:'Invalid role'});
    if(password.length<6)
      return res.status(400).json({error:'Password too short (min 6)'});
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email))
      return res.status(409).json({error:'Email already registered'});
    const hash=bcrypt.hashSync(password,12);
    const id=uuidv4();
    db.prepare("INSERT INTO users(id,name,email,phone,password,role,status,id_number) VALUES(?,?,?,?,?,?,'waiting',?)")
      .run(id,name,email,phone,hash,role,id_number||null);
    if(role==='rider'){
      db.prepare("INSERT INTO rider_profiles(user_id,bike_model,plate_number,license_number,id_number,emergency_name,emergency_phone,contract_signed,contract_date) VALUES(?,?,?,?,?,?,?,?,datetime('now'))")
        .run(id,bike_model||null,plate_number||null,license_number||null,id_number||null,emergency_name||null,emergency_phone||null,contract_signed?1:0);
    }
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const token=makeToken(user);
    // Notify admin
    const admin=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
    if(admin){
      pushNotif(admin.id,`New ${role} Registration`,`${name} (${phone}) registered as ${role} — awaiting approval.`,role==='rider'?'🚴':'👤','registration',{userId:id});
    }
    // SMS
    await sendSMS(phone,`Welcome to Nyamurani! Hi ${name}, your ${role} account was submitted. You will receive an SMS once approved. Ref: NYM-${id.slice(-6).toUpperCase()}`);
    const aPhone=process.env.ADMIN_PHONE||'+265999000000';
    const detail=role==='rider'?` | Bike:${bike_model||'?'} Plate:${plate_number||'?'}`:'';
    await sendSMS(aPhone,`[NYAMURANI] New ${role.toUpperCase()}: ${name} | ${phone}${detail} | ID:${id_number||'?'} — Log in to approve.`);
    res.status(201).json({token,user:safe(user)});
  }catch(e){ console.error('Register:',e); res.status(500).json({error:'Server error'}); }
});

// LOGIN
router.post('/login', async (req,res)=>{
  try{
    const {email,password}=req.body;
    if(!email||!password) return res.status(400).json({error:'Email and password required'});
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!user) return res.status(401).json({error:'No account found with those details'});
    if(!bcrypt.compareSync(password,user.password)) return res.status(401).json({error:'Incorrect password'});
    if(user.status==='suspended') return res.status(403).json({error:'Account suspended. Contact admin.'});
    const token=makeToken(user);
    let profile=null;
    if(user.role==='rider') profile=db.prepare('SELECT * FROM rider_profiles WHERE user_id=?').get(user.id);
    res.json({token,user:safe(user),profile});
  }catch(e){ res.status(500).json({error:'Server error'}); }
});

// ME
router.get('/me', auth, (req,res)=>{
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  let profile=null;
  if(user.role==='rider') profile=db.prepare('SELECT * FROM rider_profiles WHERE user_id=?').get(user.id);
  res.json({user:safe(user),profile});
});

// UPDATE PROFILE
router.put('/profile', auth, async (req,res)=>{
  try{
    const {name,phone,area,id_number,saved_addresses,bike_model,plate_number,license_number,emergency_name,emergency_phone}=req.body;
    db.prepare("UPDATE users SET name=COALESCE(?,name),phone=COALESCE(?,phone),area=COALESCE(?,area),id_number=COALESCE(?,id_number),saved_addresses=COALESCE(?,saved_addresses),updated_at=datetime('now') WHERE id=?")
      .run(name||null,phone||null,area||null,id_number||null,saved_addresses?JSON.stringify(saved_addresses):null,req.user.id);
    if(req.user.role==='rider'){
      db.prepare("UPDATE rider_profiles SET bike_model=COALESCE(?,bike_model),plate_number=COALESCE(?,plate_number),license_number=COALESCE(?,license_number),emergency_name=COALESCE(?,emergency_name),emergency_phone=COALESCE(?,emergency_phone) WHERE user_id=?")
        .run(bike_model||null,plate_number||null,license_number||null,emergency_name||null,emergency_phone||null,req.user.id);
    }
    const updated=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    res.json({user:safe(updated)});
  }catch(e){ res.status(500).json({error:'Server error'}); }
});

// CHANGE PASSWORD
router.put('/password', auth, (req,res)=>{
  const {old_password,new_password}=req.body;
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if(!bcrypt.compareSync(old_password,user.password)) return res.status(400).json({error:'Current password incorrect'});
  if(!new_password||new_password.length<6) return res.status(400).json({error:'New password too short'});
  db.prepare("UPDATE users SET password=?,updated_at=datetime('now') WHERE id=?").run(bcrypt.hashSync(new_password,12),req.user.id);
  res.json({message:'Password changed'});
});

// UPLOAD PHOTO
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const uploadDir=process.env.UPLOAD_DIR||'./uploads';
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir,{recursive:true});
const storage=multer.diskStorage({
  destination:(req,file,cb)=>cb(null,uploadDir),
  filename:(req,file,cb)=>cb(null,`${req.user.id}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload=multer({storage,limits:{fileSize:3*1024*1024}});

router.post('/photo', auth, upload.single('photo'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  const photo=`/uploads/${req.file.filename}`;
  db.prepare("UPDATE users SET photo=? WHERE id=?").run(photo,req.user.id);
  res.json({photo});
});

module.exports=router;
