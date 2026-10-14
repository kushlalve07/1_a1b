'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '../web'));
const PG = new Pool({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ridesync', user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'ridesync', max: Number(process.env.PGPOOL_MAX || 12),
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
});
const mongoClient = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017', {
  serverSelectionTimeoutMS: 5000, maxPoolSize: 20,
});
let mongoDb;
let mongoReady = false;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

class HttpError extends Error { constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; this.details = details; } }
const bad = (message = 'Check the supplied fields and try again.') => new HttpError(400, 'BAD_REQUEST', message);
const notFound = (code, message) => new HttpError(404, code, message);
const validUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const requireUuid = (v, label = 'id') => { if (!validUuid(v)) throw bad(`A valid ${label} is required.`); return v; };
const intParam = (v, fallback, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
const dateParam = (v, name) => { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw bad(`${name} must be a valid date.`); return d.toISOString(); };
const pgQuery = (sql, params = []) => PG.query(sql, params);
const getRider = async (id) => { const r = await pgQuery('SELECT id, name, wallet_balance FROM riders WHERE id=$1', [id]); if (!r.rowCount) throw notFound('RIDER_NOT_FOUND', 'That rider does not exist.'); return r.rows[0]; };
const getVehicle = async (id) => { const r = await pgQuery('SELECT id, license_plate, class, is_active FROM vehicles WHERE id=$1', [id]); if (!r.rowCount) throw notFound('VEHICLE_NOT_FOUND', 'That vehicle does not exist.'); return r.rows[0]; };
const send = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get('/api/health', send(async (_req, res) => {
  const checks = { postgres: false, mongodb: false };
  try { await pgQuery('SELECT 1'); checks.postgres = true; } catch (_) {}
  try { if (mongoReady) { await mongoDb.command({ ping: 1 }); checks.mongodb = true; } } catch (_) {}
  const ok = checks.postgres && checks.mongodb;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks, timestamp: new Date().toISOString() });
}));

// Browse: paginated SQL queries only; no unbounded table scans are sent to the browser.
app.get('/api/riders', send(async (req, res) => {
  const page = intParam(req.query.page, 1, 1, 1000000), pageSize = intParam(req.query.page_size, 20, 1, 100);
  const search = String(req.query.search || '').trim().slice(0, 120);
  const where = search ? 'WHERE name ILIKE $1' : '';
  const args = search ? [`%${search}%`] : [];
  const [items, count] = await Promise.all([
    pgQuery(`SELECT r.id, r.name, r.wallet_balance::text AS wallet_balance, EXISTS (SELECT 1 FROM trips t WHERE t.rider_id=r.id AND t.status IN ('REQUESTED','IN_TRANSIT')) AS has_active_trip FROM riders r ${where} ORDER BY r.name, r.id LIMIT $${args.length+1} OFFSET $${args.length+2}`, [...args, pageSize, (page-1)*pageSize]),
    pgQuery(`SELECT COUNT(*)::int AS total FROM riders ${where}`, args),
  ]);
  res.json({ items: items.rows, page, page_size: pageSize, total: count.rows[0].total });
}));
app.get('/api/riders/:id', send(async (req, res) => {
  const id = requireUuid(req.params.id, 'rider id');
  const [rider, active, count] = await Promise.all([
    getRider(id),
    pgQuery("SELECT id, status, fare_amount::text, vehicle_id, created_at FROM trips WHERE rider_id=$1 AND status IN ('REQUESTED','IN_TRANSIT') ORDER BY created_at DESC LIMIT 1", [id]),
    pgQuery('SELECT COUNT(*)::int AS trip_count FROM trips WHERE rider_id=$1', [id]),
  ]);
  res.json({ ...rider, wallet_balance: String(rider.wallet_balance), active_trip: active.rows[0] || null, trip_count: count.rows[0].trip_count });
}));
app.get('/api/vehicles', send(async (req, res) => {
  const page = intParam(req.query.page, 1, 1, 1000000), pageSize = intParam(req.query.page_size, 20, 1, 100);
  const clauses = [], args = [];
  const search = String(req.query.search || '').trim().slice(0, 80);
  if (search) { args.push(`%${search}%`); clauses.push(`license_plate ILIKE $${args.length}`); }
  if (req.query.class) { const cls = String(req.query.class).toUpperCase(); if (!['MINI','SEDAN','SUV','XL'].includes(cls)) throw bad('Unknown vehicle class.'); args.push(cls); clauses.push(`class=$${args.length}`); }
  if (req.query.is_active === 'true' || req.query.is_active === 'false') { args.push(req.query.is_active === 'true'); clauses.push(`is_active=$${args.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [items, count] = await Promise.all([
    pgQuery(`SELECT id, license_plate, class, is_active FROM vehicles ${where} ORDER BY license_plate, id LIMIT $${args.length+1} OFFSET $${args.length+2}`, [...args, pageSize, (page-1)*pageSize]),
    pgQuery(`SELECT COUNT(*)::int AS total FROM vehicles ${where}`, args),
  ]);
  res.json({ items: items.rows, page, page_size: pageSize, total: count.rows[0].total });
}));
app.get('/api/vehicles/:id', send(async (req, res) => {
  const id = requireUuid(req.params.id, 'vehicle id');
  const vehicle = await getVehicle(id);
  const [stats, metadata] = await Promise.all([
    pgQuery('SELECT completed_trip_count, total_earnings::text AS total_earnings FROM mv_vehicle_trip_stats WHERE vehicle_id=$1', [id]).catch((e) => { if (e.code === '42P01') return { rows: [] }; throw e; }),
    mongoReady ? mongoDb.collection('VehicleMetadata').findOne({ vehicle_id: id }, { projection: { _id: 0 } }).catch(() => null) : null,
  ]);
  res.json({ ...vehicle, stats: stats.rows[0] || null, metadata: metadata || null });
}));
app.get('/api/trips', send(async (req, res) => {
  const page = intParam(req.query.page, 1, 1, 1000000), limit = intParam(req.query.limit || req.query.page_size, 20, 1, 100);
  const clauses = [], args = [];
  if (req.query.status) { const s = String(req.query.status).toUpperCase(); if (!['REQUESTED','IN_TRANSIT','COMPLETED'].includes(s)) throw bad('Unknown trip status.'); args.push(s); clauses.push(`t.status=$${args.length}`); }
  const search = String(req.query.search || '').trim().slice(0, 120); if (search) { args.push(`%${search}%`); clauses.push(`(r.name ILIKE $${args.length} OR v.license_plate ILIKE $${args.length} OR t.id::text ILIKE $${args.length})`); }
  for (const key of ['rider_id','vehicle_id']) if (req.query[key]) { args.push(requireUuid(String(req.query[key]), key)); clauses.push(`t.${key}=$${args.length}`); }
  const from = dateParam(req.query.from, 'from'); const to = dateParam(req.query.to, 'to');
  if (from) { args.push(from); clauses.push(`t.created_at >= $${args.length}`); }
  if (to) { args.push(to); clauses.push(`t.created_at < $${args.length}::timestamptz + interval '1 day'`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [items, count] = await Promise.all([
    pgQuery(`SELECT t.id, t.rider_id, r.name AS rider_name, t.vehicle_id, v.license_plate, v.class, t.fare_amount::text AS fare_amount, t.status, t.created_at FROM trips t JOIN riders r ON r.id=t.rider_id JOIN vehicles v ON v.id=t.vehicle_id ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`, [...args, limit, (page-1)*limit]),
    pgQuery(`SELECT COUNT(*)::int AS total FROM trips t JOIN riders r ON r.id=t.rider_id JOIN vehicles v ON v.id=t.vehicle_id ${where}`, args),
  ]);
  res.json({ items: items.rows, page, page_size: limit, total: count.rows[0].total, next_cursor: (page*limit < count.rows[0].total) ? Buffer.from(String(page+1)).toString('base64url') : null });
}));
app.get('/api/trips/:id', send(async (req, res) => {
  const id = requireUuid(req.params.id, 'trip id');
  const result = await pgQuery('SELECT t.id, t.rider_id, r.name AS rider_name, t.vehicle_id, v.license_plate, v.class, t.fare_amount::text AS fare_amount, t.status, t.created_at FROM trips t JOIN riders r ON r.id=t.rider_id JOIN vehicles v ON v.id=t.vehicle_id WHERE t.id=$1', [id]);
  if (!result.rowCount) throw notFound('TRIP_NOT_FOUND', 'That trip does not exist.');
  let review = null;
  if (mongoReady) review = await mongoDb.collection('TripReviews').findOne({ trip_id: id }, { projection: { _id: 0 } }).catch(() => null);
  res.json({ ...result.rows[0], review });
}));

// Workflow 1: call the inherited procedure in autocommit mode (it owns its transaction).
app.post('/api/trips', send(async (req, res) => {
  const riderId = requireUuid(req.body?.rider_id, 'rider_id');
  const vehicleId = requireUuid(req.body?.vehicle_id, 'vehicle_id');
  const fare = Number(req.body?.fare_amount);
  if (!Number.isFinite(fare) || fare <= 0 || Math.round(fare*100) !== fare*100) throw new HttpError(422, 'INVALID_FARE', 'The fare must be greater than 0 and have at most two decimal places.');
  const before = await getRider(riderId);
  try { await pgQuery('CALL book_trip($1::uuid, $2::uuid, $3::numeric, NULL)', [riderId, vehicleId, fare.toFixed(2)]); }
  catch (e) {
    if (e.code === '23514' && e.constraint === 'riders_wallet_balance_check') throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Not enough wallet balance. The fare is ₹${fare.toFixed(2)} and the wallet has ₹${before.wallet_balance}. Top up and try again.`, { balance: String(before.wallet_balance) });
    if (e.code === '23505' && e.constraint === 'idx_active_rider_trip') throw new HttpError(409, 'ACTIVE_TRIP_EXISTS', 'This rider already has a trip in progress. Complete it before booking another.');
    if (e.code === 'RS001') throw new HttpError(422, 'INVALID_FARE', 'The fare must be greater than 0.');
    if (e.code === 'RS002') throw notFound('VEHICLE_NOT_FOUND', 'That vehicle does not exist.');
    if (e.code === 'RS003') throw new HttpError(409, 'VEHICLE_INACTIVE', 'That vehicle is no longer in the fleet. Pick another one.');
    if (e.code === 'RS004') throw notFound('RIDER_NOT_FOUND', 'That rider does not exist.');
    if (e.code === '22P02' || e.code === '23503') throw bad('Check the rider, vehicle and fare.');
    throw e;
  }
  const [tripResult, auditResult] = await Promise.all([
    pgQuery("SELECT id, rider_id, vehicle_id, fare_amount::text AS fare_amount, status, created_at FROM trips WHERE rider_id=$1 AND vehicle_id=$2 AND status='REQUESTED' ORDER BY created_at DESC LIMIT 1", [riderId, vehicleId]),
    pgQuery('SELECT id, action_type, amount_changed::text AS amount_changed, balance_after::text AS balance_after, "timestamp" FROM wallet_audit_logs WHERE rider_id=$1 ORDER BY "timestamp" DESC, id DESC LIMIT 1', [riderId]),
  ]);
  const audit = auditResult.rows[0];
  if (!tripResult.rowCount || !audit) throw new HttpError(500, 'POST_BOOKING_READBACK_FAILED', 'The booking was submitted, but its confirmation could not be read. Refresh trips before retrying.');
  res.status(201).json({ trip: tripResult.rows[0], balance_before: (Number(audit.balance_after)-Number(audit.amount_changed)).toFixed(2), balance_after: audit.balance_after, audit_entry: audit });
}));
app.patch('/api/trips/:id/status', send(async (req, res) => {
  const id = requireUuid(req.params.id, 'trip id'); const next = String(req.body?.status || '').toUpperCase();
  const prior = { IN_TRANSIT: 'REQUESTED', COMPLETED: 'IN_TRANSIT' };
  if (!prior[next]) throw new HttpError(422, 'INVALID_TRANSITION', 'Allowed moves are REQUESTED → IN_TRANSIT → COMPLETED.');
  const updated = await pgQuery('UPDATE trips SET status=$1 WHERE id=$2 AND status=$3 RETURNING id, rider_id, vehicle_id, fare_amount::text AS fare_amount, status, created_at', [next, id, prior[next]]);
  if (updated.rowCount) return res.json(updated.rows[0]);
  const existing = await pgQuery('SELECT status FROM trips WHERE id=$1', [id]);
  if (!existing.rowCount) throw notFound('TRIP_NOT_FOUND', 'That trip does not exist.');
  throw new HttpError(409, 'INVALID_TRANSITION', `This trip is ${existing.rows[0].status}; the requested move is not allowed.`);
}));
app.post('/api/riders/:id/wallet/topup', send(async (req, res) => {
  const id = requireUuid(req.params.id, 'rider id'); const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount*100) !== amount*100) throw new HttpError(422, 'INVALID_AMOUNT', 'Top-up must be positive and have at most two decimal places.');
  const client = await PG.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT wallet_balance::text FROM riders WHERE id=$1 FOR UPDATE', [id]);
    if (!before.rowCount) throw notFound('RIDER_NOT_FOUND', 'That rider does not exist.');
    await client.query('UPDATE riders SET wallet_balance=wallet_balance+$1::numeric WHERE id=$2', [amount.toFixed(2), id]);
    const audit = await client.query('SELECT id, action_type, amount_changed::text AS amount_changed, balance_after::text AS balance_after, "timestamp" FROM wallet_audit_logs WHERE rider_id=$1 ORDER BY "timestamp" DESC, id DESC LIMIT 1', [id]);
    await client.query('COMMIT');
    res.json({ balance_before: before.rows[0].wallet_balance, balance_after: audit.rows[0].balance_after, audit_entry: audit.rows[0] });
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; } finally { client.release(); }
}));
app.get('/api/riders/:id/audit', send(async (req, res) => {
  const id = requireUuid(req.params.id, 'rider id'); const rider = await getRider(id);
  const limit = intParam(req.query.limit, 50, 1, 200); const from = dateParam(req.query.from, 'from'); const to = dateParam(req.query.to, 'to');
  const clauses = ['rider_id=$1'], args = [id];
  if (from) { args.push(from); clauses.push(`"timestamp">=$${args.length}`); }
  if (to) { args.push(to); clauses.push(`"timestamp"<$${args.length}::timestamptz + interval '1 day'`); }
  const items = await pgQuery(`SELECT id, rider_id, amount_changed::text AS amount_changed, action_type, balance_after::text AS balance_after, "timestamp" FROM wallet_audit_logs WHERE ${clauses.join(' AND ')} ORDER BY "timestamp" DESC, id DESC LIMIT $${args.length+1}`, [...args, limit]);
  res.json({ rider: { ...rider, wallet_balance: String(rider.wallet_balance) }, items: items.rows, next_cursor: items.rowCount === limit ? 'more' : null });
}));

// Workflow 2: preserve the inherited RANGE window and DENSE_RANK logic.
const movingCte = `WITH daily_revenue AS (SELECT vehicle_id, date_trunc('day',created_at) AS trip_day, SUM(fare_amount) AS daily_fare FROM trips WHERE status='COMPLETED' GROUP BY vehicle_id,date_trunc('day',created_at)), moving_avg AS (SELECT vehicle_id,trip_day,daily_fare,ROUND(AVG(daily_fare) OVER (PARTITION BY vehicle_id ORDER BY trip_day RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW),2) AS moving_avg_7day FROM daily_revenue)`;
app.get('/api/analytics/moving-average', send(async (req, res) => {
  const vehicleId = requireUuid(String(req.query.vehicle_id || ''), 'vehicle_id'); const from = dateParam(req.query.from, 'from'); const to = dateParam(req.query.to, 'to');
  const vehicle = await getVehicle(vehicleId); const args = [vehicleId]; const filters = ['m.vehicle_id=$1'];
  if (from) { args.push(from); filters.push(`m.trip_day >= $${args.length}::timestamptz`); }
  if (to) { args.push(to); filters.push(`m.trip_day < $${args.length}::timestamptz + interval '1 day'`); }
  const q = await pgQuery(`${movingCte} SELECT m.trip_day,m.daily_fare::text AS daily_fare,m.moving_avg_7day::text AS moving_avg_7day FROM moving_avg m WHERE ${filters.join(' AND ')} ORDER BY m.trip_day`, args);
  res.json({ vehicle, series: q.rows });
}));
app.get('/api/analytics/rankings', send(async (req, res) => {
  const day = dateParam(req.query.day, 'day'); const limit = intParam(req.query.limit, 20, 1, 100);
  const dayResult = day ? { rows: [{ day }] } : await pgQuery("SELECT MAX(date_trunc('day',created_at)) AS day FROM trips WHERE status='COMPLETED'");
  if (!dayResult.rows[0]?.day) return res.json({ day: null, items: [] });
  const args = [dayResult.rows[0].day, limit];
  const q = await pgQuery(`${movingCte}, ranked AS (SELECT m.*, DENSE_RANK() OVER (PARTITION BY m.trip_day ORDER BY m.moving_avg_7day DESC) AS revenue_rank FROM moving_avg m) SELECT x.revenue_rank,x.vehicle_id,v.license_plate,v.class,x.trip_day,x.daily_fare::text AS daily_fare,x.moving_avg_7day::text AS moving_avg_7day FROM ranked x JOIN vehicles v ON v.id=x.vehicle_id WHERE x.trip_day >= date_trunc('day',$1::timestamptz) AND x.trip_day < date_trunc('day',$1::timestamptz)+interval '1 day' ORDER BY x.revenue_rank,x.vehicle_id LIMIT $2`, args);
  res.json({ day: new Date(dayResult.rows[0].day).toISOString().slice(0,10), items: q.rows });
}));
app.get('/api/analytics/vehicle-stats', send(async (req, res) => {
  const page = intParam(req.query.page, 1, 1, 1000000), pageSize = intParam(req.query.page_size, 20, 1, 100); const sort = ['total_earnings','completed_trip_count'].includes(req.query.sort) ? req.query.sort : 'total_earnings';
  const summary = await pgQuery(`SELECT COUNT(*)::int AS vehicles, COALESCE(SUM(completed_trip_count),0)::bigint AS completed_trips, COALESCE(SUM(total_earnings),0)::text AS total_earnings, (SELECT json_build_object('license_plate',license_plate,'total_earnings',total_earnings::text) FROM mv_vehicle_trip_stats ORDER BY total_earnings DESC LIMIT 1) AS top_vehicle FROM mv_vehicle_trip_stats`);
  const [items, refreshed] = await Promise.all([
    pgQuery(`SELECT vehicle_id,license_plate,class,completed_trip_count,total_earnings::text AS total_earnings FROM mv_vehicle_trip_stats ORDER BY ${sort} DESC, license_plate LIMIT $1 OFFSET $2`, [pageSize,(page-1)*pageSize]),
    pgQuery("SELECT last_refreshed_at FROM mv_vehicle_trip_stats_refresh WHERE id=1").catch(e => { if(e.code==='42P01') return {rows:[]}; throw e; }),
  ]);
  res.json({ summary: summary.rows[0], last_refreshed_at: refreshed.rows[0]?.last_refreshed_at || null, items: items.rows, page, page_size: pageSize, total: Number(summary.rows[0].vehicles) });
}));
app.post('/api/analytics/vehicle-stats/refresh', send(async (_req, res) => {
  const start = Date.now(); await pgQuery('SELECT refresh_vehicle_trip_stats()');
  const stamp = await pgQuery('SELECT last_refreshed_at FROM mv_vehicle_trip_stats_refresh WHERE id=1');
  res.json({ last_refreshed_at: stamp.rows[0]?.last_refreshed_at || new Date().toISOString(), duration_ms: Date.now()-start });
}));

// Workflow 3: $geoNear is the first Mongo pipeline stage and radius is capped at 5km.
app.get('/api/vehicles/nearby', send(async (req, res) => {
  if (!mongoReady) throw new HttpError(503, 'MONGODB_UNAVAILABLE', 'Live map is unavailable until MongoDB connects.');
  const lng = Number(req.query.lng), lat = Number(req.query.lat); if (!Number.isFinite(lng)||!Number.isFinite(lat)||lng < -180||lng>180||lat < -90||lat>90) throw new HttpError(422,'INVALID_ORIGIN','Choose a valid longitude and latitude.');
  const radius = Math.min(5000, Math.max(1, Number(req.query.radius_m)||5000)); const limit = intParam(req.query.limit,20,1,50);
  const raw = await mongoDb.collection('TelemetryPings').aggregate([
    { $geoNear: { near: { type:'Point', coordinates:[lng,lat] }, distanceField:'distance_meters', maxDistance:radius, query:{is_available:true}, spherical:true } },
    { $sort:{distance_meters:1} },
    { $group:{ _id:'$vehicle_id', distance_meters:{$first:'$distance_meters'}, location:{$first:'$location'}, created_at:{$first:'$created_at'} } },
    { $sort:{distance_meters:1} }, { $limit:limit },
    { $project:{_id:0,vehicle_id:'$_id',distance_meters:1,location:1,created_at:1} },
  ], { maxTimeMS: 8000 }).toArray();
  const ids = raw.map(x=>x.vehicle_id).filter(validUuid); let vehicles = [];
  if (ids.length) { const v = await pgQuery('SELECT id,license_plate,class,is_active FROM vehicles WHERE id=ANY($1::uuid[])',[ids]); vehicles=v.rows; }
  const byId = new Map(vehicles.map(v=>[v.id,v])); const results = raw.filter(x=>byId.has(x.vehicle_id)).map(x=>({ ...x, ...byId.get(x.vehicle_id), location:{lng:x.location.coordinates[0],lat:x.location.coordinates[1]} }));
  res.json({ origin:{lng,lat}, radius_m:radius, generated_at:new Date().toISOString(), results });
}));
app.post('/api/telemetry/simulate', send(async (req, res) => {
  if (!mongoReady) throw new HttpError(503, 'MONGODB_UNAVAILABLE', 'Telemetry simulator needs MongoDB.');
  const count = intParam(req.body?.vehicles,50,1,200); const vehicles = await pgQuery('SELECT id FROM vehicles WHERE is_active=true ORDER BY random() LIMIT $1',[count]);
  const collection = mongoDb.collection('TelemetryPings'); const ids = vehicles.rows.map(v=>v.id); const previous = ids.length ? await collection.aggregate([{ $match:{vehicle_id:{$in:ids}} },{ $sort:{created_at:-1} },{ $group:{_id:'$vehicle_id',location:{$first:'$location'}} }]).toArray() : [];
  const pos = new Map(previous.map(x=>[x._id,x.location.coordinates])); const now = new Date();
  const docs = ids.map(id=>{ const old=pos.get(id)||[78.4867,17.385]; const lng=old[0]+(Math.random()-.5)*.002, lat=old[1]+(Math.random()-.5)*.002; return {vehicle_id:id,location:{type:'Point',coordinates:[lng,lat]},is_available:Math.random()<.8,created_at:now}; });
  if (docs.length) await collection.insertMany(docs,{ordered:false}); res.status(201).json({inserted:docs.length});
}));

// Workflow 4: inherited $facet computes all review metrics from one matched set.
app.get('/api/reviews/stats', send(async (req, res) => {
  if (!mongoReady) throw new HttpError(503,'MONGODB_UNAVAILABLE','Review analytics need MongoDB.');
  const match = {}; if (req.query.vehicle_id) match.vehicle_id=requireUuid(String(req.query.vehicle_id),'vehicle_id');
  const rows = await mongoDb.collection('TripReviews').aggregate([{ $match:match },{ $facet:{ rating_distribution:[{$group:{_id:'$rating',count:{$sum:1}}},{$sort:{_id:1}}], top_tags:[{$unwind:'$tags'},{$group:{_id:'$tags',count:{$sum:1}}},{$sort:{count:-1}},{$limit:8},{$project:{_id:0,tag:'$_id',count:1}}], average:[{$group:{_id:null,average_rating:{$avg:'$rating'},review_count:{$sum:1}}},{$project:{_id:0,average_rating:1,review_count:1}}] } }],{maxTimeMS:10000}).toArray();
  const x=rows[0]||{rating_distribution:[],top_tags:[],average:[]}; const dist=new Map(x.rating_distribution.map(i=>[i._id,i.count])); const avg=x.average[0]||{};
  res.json({scope:{vehicle_id:match.vehicle_id||null},rating_distribution:[1,2,3,4,5].map(rating=>({rating,count:dist.get(rating)||0})),top_tags:x.top_tags,average_rating:avg.average_rating??null,review_count:avg.review_count||0});
}));
app.get('/api/reviews', send(async (req, res) => {
  if (!mongoReady) throw new HttpError(503,'MONGODB_UNAVAILABLE','Reviews need MongoDB.');
  const page=intParam(req.query.page,1,1,1000000), pageSize=intParam(req.query.page_size,20,1,100); const filter={}; if(req.query.vehicle_id) filter.vehicle_id=requireUuid(String(req.query.vehicle_id),'vehicle_id');
  const col=mongoDb.collection('TripReviews'); const [items,total]=await Promise.all([col.find(filter,{projection:{_id:0}}).sort({created_at:-1}).skip((page-1)*pageSize).limit(pageSize).toArray(),col.countDocuments(filter)]);
  res.json({items,page,page_size:pageSize,total});
}));

app.use('/api', (_req,res) => res.status(404).json({error:{code:'ENDPOINT_NOT_FOUND',message:'That API endpoint does not exist.'}}));
app.use(express.static(WEB_DIR, { extensions:['html'], maxAge: process.env.NODE_ENV==='production' ? '1h' : 0 }));
app.get('*', (_req,res) => res.sendFile(path.join(WEB_DIR,'index.html')));
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) return res.status(err.status).json({error:{code:err.code,message:err.message,...(err.details||{})}});
  if (err?.type === 'entity.parse.failed') return res.status(400).json({error:{code:'INVALID_JSON',message:'Request body must be valid JSON.'}});
  console.error('[api-error]', {message:err.message,code:err.code,detail:err.detail});
  res.status(500).json({error:{code:'INTERNAL',message:'Something went wrong. Please try again.'}});
});

async function start() {
  try { await mongoClient.connect(); mongoDb=mongoClient.db(process.env.MONGO_DB||'ridesync'); await mongoDb.command({ping:1}); mongoReady=true; console.log('[startup] MongoDB connected'); }
  catch (e) { mongoReady=false; console.warn(`[startup] MongoDB unavailable; SQL screens remain usable (${e.message})`); }
  const server=app.listen(PORT,()=>console.log(`[startup] RideSync available at http://localhost:${PORT}`));
  const shutdown=async()=>{server.close(async()=>{await PG.end().catch(()=>{});await mongoClient.close().catch(()=>{});process.exit(0);});setTimeout(()=>process.exit(1),8000).unref();};
  process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
}
if (require.main===module) start();
module.exports={app,PG};
