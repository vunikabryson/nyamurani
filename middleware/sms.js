const db = require('../db/connection');
async function sendSMS(phone,message){
  try{ db.prepare('INSERT INTO sms_log(phone,message,status) VALUES(?,?,?)').run(phone,message,'queued'); }catch(e){}
  const {AT_API_KEY:key,AT_USERNAME:user,AT_SENDER_ID:from='Nyamurani'}=process.env;
  if(key&&user){
    try{
      const p=new URLSearchParams({username:user,to:phone,message,from});
      const r=await fetch('https://api.africastalking.com/version1/messaging',{
        method:'POST',
        headers:{apiKey:key,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
        body:p.toString()
      });
      const d=await r.json();
      const s=d.SMSMessageData?.Recipients?.[0]?.status||'sent';
      try{ db.prepare('UPDATE sms_log SET status=?,provider=? WHERE id=(SELECT MAX(id) FROM sms_log WHERE phone=?)').run(s,'africastalking',phone); }catch(e){}
      console.log(`SMS→${phone}: ${s}`);
      return {success:true,provider:'africastalking',status:s};
    }catch(e){ console.error('AT SMS error:',e.message); }
  }
  console.log(`[SMS-SIM]→${phone}: ${message}`);
  try{ db.prepare('UPDATE sms_log SET status=?,provider=? WHERE id=(SELECT MAX(id) FROM sms_log WHERE phone=?)').run('simulated','simulation',phone); }catch(e){}
  return {success:true,provider:'simulation'};
}
module.exports={sendSMS};
