const { v4:uuidv4 } = require('uuid');
const db = require('../db/connection');

function safe(u){ if(!u)return null; const {password,...r}=u; return r; }

function makeToken(user){
  const jwt=require('jsonwebtoken');
  return jwt.sign({id:user.id,role:user.role},process.env.JWT_SECRET,{expiresIn:'30d'});
}

function pushNotif(userId,title,message,icon='🔔',type='info',data={}){
  try{
    db.prepare('INSERT INTO notifications(id,user_id,title,message,icon,type,data) VALUES(?,?,?,?,?,?,?)')
      .run(uuidv4(),userId,title,message,icon,type,JSON.stringify(data));
    db.prepare('INSERT INTO events(id,type,payload) VALUES(?,?,?)')
      .run(uuidv4(),'notification',JSON.stringify({userId,title,message,icon,type,data}));
  }catch(e){ console.error('pushNotif error:',e.message); }
}

function audit(adminId,adminName,action,targetId,targetName,targetRole,reason=''){
  try{
    db.prepare('INSERT INTO audit_log(admin_id,admin_name,action,target_id,target_name,target_role,reason) VALUES(?,?,?,?,?,?,?)')
      .run(adminId,adminName,action,targetId||null,targetName||null,targetRole||null,reason||null);
  }catch(e){}
}

module.exports={safe,makeToken,pushNotif,audit};
