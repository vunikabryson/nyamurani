const jwt = require('jsonwebtoken');
const db  = require('../db/connection');
function auth(req,res,next){
  const h=req.headers.authorization;
  if(!h||!h.startsWith('Bearer ')) return res.status(401).json({error:'No token'});
  try{
    const p=jwt.verify(h.slice(7),process.env.JWT_SECRET);
    const u=db.prepare('SELECT * FROM users WHERE id=?').get(p.id);
    if(!u) return res.status(401).json({error:'User not found'});
    if(u.status==='suspended') return res.status(403).json({error:'Account suspended'});
    req.user=u; next();
  }catch(e){ return res.status(401).json({error:'Invalid token'}); }
}
function admin(req,res,next){ if(req.user?.role!=='admin') return res.status(403).json({error:'Admin only'}); next(); }
function rider(req,res,next){ if(req.user?.role!=='rider') return res.status(403).json({error:'Rider only'}); next(); }
module.exports={auth,admin,rider};
