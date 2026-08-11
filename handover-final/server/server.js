
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import { Pool } from 'pg';
import { z } from 'zod';
import crypto from 'node:crypto';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));

const sign = (user) => jwt.sign(
  { sub: user.id, role: user.role, email: user.email, phone: user.phone },
  process.env.JWT_SECRET,
  { expiresIn: '2h', issuer: 'aishwarya-store' }
);

function auth(req, res, next) {
  try {
    const token = req.cookies.aishwarya_session;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'aishwarya-store' });
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired session' }); }
}

function allow(...roles) {
  return (req, res, next) => roles.includes(req.user?.role)
    ? next() : res.status(403).json({ error: 'Not authorized' });
}

async function audit(actorId, action, entityType, entityId, metadata={}) {
  await pool.query(
    `INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)`,
    [actorId, action, entityType, entityId, metadata]
  );
}

async function getUserById(id) {
  const { rows } = await pool.query(
    `SELECT id,name,email,phone,role,totp_secret,is_active FROM users WHERE id=$1 LIMIT 1`,
    [id]
  );
  return rows[0];
}

app.post('/api/admin/bootstrap', async (req, res) => {
  const key = req.get('x-bootstrap-key');
  if (!process.env.ADMIN_BOOTSTRAP_KEY || key !== process.env.ADMIN_BOOTSTRAP_KEY) return res.status(403).json({error:'Invalid bootstrap key'});
  const { rows: owners } = await pool.query(`SELECT id FROM users WHERE role='owner' LIMIT 1`);
  if (owners.length) return res.status(409).json({error:'Owner already configured'});
  const { name, email, phone, password } = z.object({name:z.string().min(2),email:z.string().email(),phone:z.string().optional(),password:z.string().min(12)}).parse(req.body);
  const hash=await bcrypt.hash(password,12);
  const { rows }=await pool.query(`INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'owner') RETURNING id,name,email,phone,role`,[name,email,phone||null,hash]);
  res.status(201).json(rows[0]);
});


app.get('/api/admin/me', auth, allow('owner','staff'), async (req,res) => {
  const user = await getUserById(req.user.sub);
  if (!user) return res.status(404).json({error:'Admin not found'});
  res.json({
    id:user.id, name:user.name, email:user.email, phone:user.phone, role:user.role,
    totpConfigured:Boolean(user.totp_secret)
  });
});

app.post('/api/admin/totp/setup', auth, allow('owner','staff'), async (req,res) => {
  const user = await getUserById(req.user.sub);
  if (!user) return res.status(404).json({error:'Admin not found'});
  if (user.totp_secret) return res.status(409).json({error:'Authenticator already configured'});

  const secret = speakeasy.generateSecret({
    name: `Aishwarya (${user.email || user.phone || user.name})`,
    issuer: 'Almara by Aishwarya',
    length: 20
  });

  // Return only to the authenticated admin. It is not persisted until verification succeeds.
  const qrDataUrl = await (await import('qrcode')).default.toDataURL(secret.otpauth_url, {
    width: 280, margin: 2
  });

  res.json({
    secret: secret.base32,
    otpauthUrl: secret.otpauth_url,
    qrDataUrl
  });
});

app.post('/api/admin/totp/verify', auth, allow('owner','staff'), async (req,res) => {
  const body = z.object({
    secret: z.string().min(16),
    code: z.string().regex(/^\d{6}$/)
  }).parse(req.body);

  const valid = speakeasy.totp.verify({
    secret: body.secret,
    encoding: 'base32',
    token: body.code,
    window: 1
  });
  if (!valid) return res.status(400).json({error:'That authenticator code is not valid. Try the current 6-digit code.'});

  await pool.query(`UPDATE users SET totp_secret=$1 WHERE id=$2`, [body.secret, req.user.sub]);
  await audit(req.user.sub,'auth.totp_enabled','user',req.user.sub);
  res.json({ok:true});
});

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'Aishwarya Store API' }));


function setupToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m', issuer: 'aishwarya-setup' });
}
function verifySetupToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { issuer: 'aishwarya-setup' });
}

app.get('/api/admin/setup/status', async (_, res) => {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role='owner'`);
  res.json({ ownerExists: rows[0].count > 0 });
});

app.post('/api/admin/setup/start', async (req, res) => {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role='owner' LIMIT 1`);
  if (rows.length) return res.status(409).json({ error: 'Owner account already exists. Use sign in.' });
  const body = z.object({
    setupKey: z.string().min(8), name:z.string().min(2).max(100),
    email:z.string().email(), phone:z.string().regex(/^\+?[1-9]\d{9,14}$/),
    password:z.string().min(12).max(100), confirmPassword:z.string().min(12).max(100)
  }).parse(req.body);
  if (!process.env.ADMIN_BOOTSTRAP_KEY || body.setupKey !== process.env.ADMIN_BOOTSTRAP_KEY)
    return res.status(403).json({ error:'Invalid setup key' });
  if (body.password !== body.confirmPassword) return res.status(400).json({ error:'Passwords do not match' });
  const code=String(crypto.randomInt(100000,1000000));
  const hash=await bcrypt.hash(code,10);
  await pool.query(`DELETE FROM otp_challenges WHERE destination=$1 AND purpose='admin_setup'`,[body.email]);
  await pool.query(`INSERT INTO otp_challenges(destination,code_hash,purpose,expires_at) VALUES($1,$2,'admin_setup',now()+interval '10 minutes')`,[body.email,hash]);
  const token=setupToken({kind:'admin_setup',name:body.name,email:body.email,phone:body.phone,passwordHash:await bcrypt.hash(body.password,12)});
  if (process.env.OTP_PROVIDER === 'console' || process.env.NODE_ENV !== 'production') console.log(`[ADMIN SETUP OTP] ${body.email}: ${code}`);
  res.json({ ok:true, setupToken:token, message:'Verification code sent to the configured email/SMS provider.' });
});

app.post('/api/admin/setup/verify-otp', async (req,res) => {
  const body=z.object({setupToken:z.string().min(20),code:z.string().regex(/^\\d{6}$/)}).parse(req.body);
  let setup; try { setup=verifySetupToken(body.setupToken); } catch { return res.status(400).json({error:'Setup session expired. Start again.'}); }
  if(setup.kind!=='admin_setup') return res.status(400).json({error:'Invalid setup session'});
  const {rows}=await pool.query(`SELECT * FROM otp_challenges WHERE destination=$1 AND purpose='admin_setup' AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[setup.email]);
  if(!rows[0] || !(await bcrypt.compare(body.code,rows[0].code_hash))) return res.status(400).json({error:'Invalid or expired verification code'});
  await pool.query(`UPDATE otp_challenges SET consumed_at=now() WHERE id=$1`,[rows[0].id]);
  const {rows: owners}=await pool.query(`SELECT id FROM users WHERE role='owner' LIMIT 1`);
  if(owners.length) return res.status(409).json({error:'Owner account already configured'});
  const {rows:users}=await pool.query(`INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'owner') RETURNING id,name,email,phone,role`,[setup.name,setup.email,setup.phone,setup.passwordHash]);
  const user=users[0];
  res.cookie('aishwarya_setup_admin', setupToken({kind:'admin_setup_admin',sub:user.id}), {httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',maxAge:15*60*1000});
  res.json({ok:true,admin:{id:user.id,name:user.name,email:user.email}});
});

app.post('/api/admin/setup/totp', async (req,res) => {
  const token=req.cookies.aishwarya_setup_admin;
  if(!token) return res.status(401).json({error:'Setup session expired'});
  let payload; try {payload=verifySetupToken(token)} catch {return res.status(401).json({error:'Setup session expired'});}
  if(payload.kind!=='admin_setup_admin') return res.status(401).json({error:'Invalid setup session'});
  const {rows}=await pool.query(`SELECT id,name,email,totp_secret FROM users WHERE id=$1 AND role='owner'`,[payload.sub]);
  const user=rows[0]; if(!user) return res.status(404).json({error:'Owner not found'});
  if(user.totp_secret) return res.status(409).json({error:'Authenticator already configured'});
  const secret=speakeasy.generateSecret({name:`Aishwarya (${user.email})`,issuer:'Almara by Aishwarya',length:20});
  const qrDataUrl=await (await import('qrcode')).default.toDataURL(secret.otpauth_url,{width:280,margin:2});
  res.json({secret:secret.base32,otpauthUrl:secret.otpauth_url,qrDataUrl});
});

app.post('/api/admin/setup/complete', async (req,res) => {
  const token=req.cookies.aishwarya_setup_admin;
  if(!token) return res.status(401).json({error:'Setup session expired'});
  let payload; try {payload=verifySetupToken(token)} catch {return res.status(401).json({error:'Setup session expired'});}
  if(payload.kind!=='admin_setup_admin') return res.status(401).json({error:'Invalid setup session'});
  const body=z.object({secret:z.string().min(16),code:z.string().regex(/^\\d{6}$/)}).parse(req.body);
  const valid=speakeasy.totp.verify({secret:body.secret,encoding:'base32',token:body.code,window:1});
  if(!valid) return res.status(400).json({error:'That authenticator code is not valid. Try the current 6-digit code.'});
  await pool.query(`UPDATE users SET totp_secret=$1 WHERE id=$2 AND role='owner'`,[body.secret,payload.sub]);
  await pool.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id) VALUES($1,'owner.setup_completed','user',$1)`,[payload.sub]);
  res.clearCookie('aishwarya_setup_admin');
  res.json({ok:true, message:'Owner setup complete. Sign in with your password and current authenticator code.'});
});

app.post('/api/auth/register', async (req, res) => {
  const body = z.object({
    name: z.string().min(2).max(100),
    email: z.string().email().optional(),
    phone: z.string().regex(/^\+?[1-9]\d{9,14}$/).optional(),
    password: z.string().min(8).max(100)
  }).refine(v => v.email || v.phone, { message: 'Email or phone required' }).parse(req.body);
  const hash = await bcrypt.hash(body.password, 12);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users(name,email,phone,password_hash) VALUES($1,$2,$3,$4)
       RETURNING id,name,email,phone,role`, [body.name, body.email || null, body.phone || null, hash]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(409).json({ error: 'Account already exists' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const body = z.object({
    identifier: z.string().min(3),
    password: z.string().min(8),
    totp: z.string().regex(/^\d{6}$/).optional()
  }).parse(req.body);

  const { rows } = await pool.query(
    `SELECT * FROM users WHERE (email=$1 OR phone=$1) AND is_active=true LIMIT 1`,
    [body.identifier]
  );
  const user = rows[0];

  if (!user || !user.password_hash || !(await bcrypt.compare(body.password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });

  const isAdmin = user.role === 'owner' || user.role === 'staff';

  if (isAdmin && user.totp_secret) {
    if (!body.totp || !speakeasy.totp.verify({
      secret: user.totp_secret, encoding: 'base32', token: body.totp, window: 1
    })) {
      return res.status(401).json({ error: 'Invalid or missing Google Authenticator code' });
    }
  }

  res.cookie('aishwarya_session', sign(user), {
    httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 2 * 60 * 60 * 1000
  });

  res.json({
    id:user.id, name:user.name, role:user.role,
    totpConfigured: Boolean(user.totp_secret)
  });
});

app.post('/api/auth/logout', (_, res) => {
  res.clearCookie('aishwarya_session');
  res.status(204).end();
});

app.post('/api/auth/otp/request', async (req, res) => {
  const body = z.object({ destination: z.string().min(5), purpose: z.enum(['login','sensitive_action']) }).parse(req.body);
  const code = String(crypto.randomInt(100000, 1000000));
  const hash = await bcrypt.hash(code, 10);
  await pool.query(
    `INSERT INTO otp_challenges(destination,code_hash,purpose,expires_at)
     VALUES($1,$2,$3,now()+interval '5 minutes')`, [body.destination, hash, body.purpose]
  );
  // Production: replace console delivery with a verified SMS/email provider.
  if (process.env.OTP_PROVIDER === 'console') console.log(`[DEV OTP] ${body.destination}: ${code}`);
  res.json({ ok:true, message:'OTP sent' });
});

app.get('/api/products', async (_, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, c.name AS category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.status <> 'removed'
    ORDER BY p.created_at DESC`);
  res.json(rows);
});

app.post('/api/analytics/events', async (req, res) => {
  const body = z.object({
    event_name: z.string().min(1).max(80),
    path: z.string().max(500).optional(),
    session_id: z.string().max(100).optional(),
    metadata: z.record(z.string(), z.any()).optional()
  }).parse(req.body);
  await pool.query(
    `INSERT INTO analytics_events(user_id,session_id,event_name,path,metadata)
     VALUES($1,$2,$3,$4,$5)`,
    [req.user?.sub || null, body.session_id || null, body.event_name, body.path || null, body.metadata || {}]
  );
  res.status(204).end();
});

app.get('/api/admin/overview', auth, allow('owner','staff'), async (_, res) => {
  const [sales, orders, customers, products, events] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(total_inr),0) revenue FROM orders WHERE payment_status='paid'`),
    pool.query(`SELECT COUNT(*) count FROM orders`),
    pool.query(`SELECT COUNT(*) count FROM users WHERE role='customer'`),
    pool.query(`SELECT COUNT(*) count FROM products WHERE status='active'`),
    pool.query(`SELECT COUNT(*) count FROM analytics_events WHERE created_at >= now()-interval '30 days'`)
  ]);
  res.json({
    revenue: sales.rows[0].revenue,
    orders: orders.rows[0].count,
    customers: customers.rows[0].count,
    activeProducts: products.rows[0].count,
    events30d: events.rows[0].count
  });
});

app.get('/api/admin/orders', auth, allow('owner','staff'), async (_, res) => {
  const { rows } = await pool.query(`
    SELECT o.*, u.name customer_name, u.email, u.phone
    FROM orders o LEFT JOIN users u ON u.id=o.user_id
    ORDER BY o.created_at DESC LIMIT 200`);
  res.json(rows);
});

app.post('/api/admin/products', auth, allow('owner','staff'), async (req,res) => {
  const body = z.object({
    name:z.string().min(2), slug:z.string().min(2),
    description:z.string().optional(), category_id:z.string().uuid().nullable().optional(),
    price_inr:z.number().int().nonnegative(), compare_price_inr:z.number().int().nonnegative().nullable().optional(),
    image_url:z.string().url(), gallery:z.array(z.string().url()).optional(),
    sku:z.string().max(80).nullable().optional(), stock:z.number().int().nonnegative()
  }).parse(req.body);
  const { rows } = await pool.query(`
    INSERT INTO products(name,slug,description,category_id,price_inr,compare_price_inr,image_url,gallery,sku,stock)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [body.name,body.slug,body.description||'',body.category_id||null,body.price_inr,body.compare_price_inr||null,
     body.image_url,JSON.stringify(body.gallery||[]),body.sku||null,body.stock]
  );
  await audit(req.user.sub,'product.create','product',rows[0].id);
  res.status(201).json(rows[0]);
});

app.patch('/api/admin/products/:id', auth, allow('owner','staff'), async (req,res) => {
  const allowed = z.object({
    name:z.string().min(2).optional(), price_inr:z.number().int().nonnegative().optional(),
    stock:z.number().int().nonnegative().optional(), status:z.enum(['active','out_of_stock','removed']).optional(),
    image_url:z.string().url().optional(), category_id:z.string().uuid().nullable().optional()
  }).parse(req.body);
  const keys=Object.keys(allowed); if(!keys.length) return res.status(400).json({error:'No changes'});
  const sets=keys.map((k,i)=>`${k}=$${i+1}`).join(',');
  const vals=keys.map(k=>allowed[k]);
  vals.push(req.params.id);
  const { rows }=await pool.query(`UPDATE products SET ${sets},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);
  if(!rows[0]) return res.status(404).json({error:'Product not found'});
  await audit(req.user.sub,'product.update','product',req.params.id,allowed);
  res.json(rows[0]);
});


app.get('/api/admin/staff', auth, allow('owner'), async (_,res) => {
  const { rows } = await pool.query(
    `SELECT id,name,email,phone,role,is_active,(totp_secret IS NOT NULL) AS totp_configured,created_at
     FROM users WHERE role IN ('owner','staff') ORDER BY created_at`
  );
  res.json(rows);
});

app.post('/api/admin/staff', auth, allow('owner'), async (req,res) => {
  const body=z.object({
    name:z.string().min(2).max(100),
    email:z.string().email(),
    phone:z.string().regex(/^\+?[1-9]\d{9,14}$/).optional(),
    password:z.string().min(12).max(100)
  }).parse(req.body);
  const hash=await bcrypt.hash(body.password,12);
  try {
    const {rows}=await pool.query(
      `INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'staff')
       RETURNING id,name,email,phone,role,is_active`,
      [body.name,body.email,body.phone||null,hash]
    );
    await audit(req.user.sub,'staff.create','user',rows[0].id);
    res.status(201).json(rows[0]);
  } catch { res.status(409).json({error:'A staff account with that email or phone already exists'}); }
});

app.get('/api/admin/analytics', auth, allow('owner','staff'), async (_, res) => {
  const { rows } = await pool.query(`
    SELECT date_trunc('day',created_at)::date day,event_name,COUNT(*) count
    FROM analytics_events
    WHERE created_at >= now()-interval '30 days'
    GROUP BY 1,2 ORDER BY 1`);
  res.json(rows);
});

export default app;

if (process.env.NETLIFY !== 'true') {
  app.listen(port, () => console.log(`Aishwarya API running on :${port}`));
}
