const express=require('express');
const router=express.Router();
const db=require('../db/connection');
const {auth}=require('../middleware/auth');
router.use(auth);
router.get('/',(req,res)=>{
  const {limit=50,offset=0,unread_only}=req.query;
  let q='SELECT * FROM notifications WHERE user_id=?';const p=[req.user.id];
  if(unread_only==='true'){q+=' AND read_flag=0';}
  q+=' ORDER BY created_at DESC LIMIT ? OFFSET ?';p.push(Number(limit),Number(offset));
  const notifications=db.prepare(q).all(...p);
  const unread=db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_flag=0').get(req.user.id).c;
  res.json({notifications,unread});
});
router.put('/:id/read',(req,res)=>{db.prepare('UPDATE notifications SET read_flag=1 WHERE id=? AND user_id=?').run(req.params.id,req.user.id);res.json({message:'ok'});});
router.put('/read-all',(req,res)=>{db.prepare('UPDATE notifications SET read_flag=1 WHERE user_id=?').run(req.user.id);res.json({message:'ok'});});
router.delete('/:id',(req,res)=>{db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(req.params.id,req.user.id);res.json({message:'ok'});});
router.get('/events',(req,res)=>{
  const {since=0}=req.query;
  const sinceDate=new Date(Number(since)).toISOString();
  const events=db.prepare("SELECT * FROM events WHERE created_at>? ORDER BY created_at ASC LIMIT 30").all(sinceDate);
  res.json({events,serverTime:Date.now()});
});
module.exports=router;
