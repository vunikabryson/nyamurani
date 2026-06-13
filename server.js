// ═══════════════════════════════════════════════════════════════
//  NYAMURANI API SERVER — server.js
//  Serves both the REST API and the frontend HTML
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── SECURITY ──
app.use(helmet({
  contentSecurityPolicy: false,  // disabled so inline scripts work
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o=>o.trim());
app.use(cors({
  origin: origins.includes('*') ? '*' : (origin, cb) => {
    if(!origin || origins.includes(origin)) cb(null,true); else cb(new Error('CORS'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

app.use(express.json({ limit:'10mb' }));
app.use(express.urlencoded({ extended:true, limit:'10mb' }));

// ── RATE LIMITS ──
app.use('/api/', rateLimit({ windowMs:15*60*1000, max:500, message:{error:'Too many requests'} }));
app.use('/api/auth/', rateLimit({ windowMs:15*60*1000, max:30, message:{error:'Too many auth attempts'} }));

// ── STATIC UPLOADS ──
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir,{recursive:true});
app.use('/uploads', express.static(path.resolve(uploadDir)));

// ── SERVE FRONTEND (if it exists in public/ folder) ──
const publicDir = path.join(__dirname,'public');
if(fs.existsSync(publicDir)){
  app.use(express.static(publicDir));
  console.log('Serving frontend from /public');
}

// ── HEALTH CHECK ──
app.get('/health', (req,res) => {
  res.json({
    status:'ok',
    service:'Nyamurani API',
    version:'1.0.0',
    time: new Date().toISOString(),
    frontend: fs.existsSync(path.join(publicDir,'index.html')) ? 'served' : 'external'
  });
});

// ── API ROUTES ──
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/orders',        require('./routes/orders'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/riders',        require('./routes/riders'));

// ── SPA FALLBACK (serve index.html for any non-API route) ──
app.get('*', (req,res) => {
  const index = path.join(publicDir,'index.html');
  if(fs.existsSync(index)) res.sendFile(index);
  else res.status(404).json({error:'Route not found'});
});

// ── ERROR HANDLER ──
app.use((err,req,res,next) => {
  console.error('Error:', err.message);
  res.status(500).json({error:'Internal server error'});
});

// ── START ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  🚴 Nyamurani API Server                     ║
║  Port   : ${PORT}                                ║
║  Health : http://localhost:${PORT}/health         ║
║  API    : http://localhost:${PORT}/api/           ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
