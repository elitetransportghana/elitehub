// Cloudflare Worker (module) to serve routes and passenger read endpoints from a D1 database.
// Bind your D1 database to the Worker with the binding name `DB` (change code if you use a different binding).
// Example wrangler.toml binding snippet:
// [[d1_databases]]
// binding = "DB"
// database_name = "elite_routes"

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '');

    // OPTIONS (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      await ensureOperationalSchema(env);

      // Compatibility fallback: some Paystack integrations may still post to root "/".
      // Only treat it as webhook when Paystack signature header is present.
      if (pathname === '' && request.method === 'POST' && request.headers.get('x-paystack-signature')) {
        return await handlePaystackWebhook(env, request);
      }

      if (pathname === '/api/routes' && request.method === 'GET') {
        return await handleGetRoutes(env);
      }

      if (pathname === '/api/passengers' && request.method === 'GET') {
        return await handleGetPassengers(env, request);
      }

      // NEW: Get seat availability for a bus
      const busSeatsMatch = pathname.match(/^\/api\/bus\/(\d+)\/seats$/);
      if (busSeatsMatch && request.method === 'GET') {
        const busId = busSeatsMatch[1];
        return await handleGetBusSeats(env, busId, request);
      }

      // NEW: Lock a seat (temporary hold)
      const lockSeatMatch = pathname.match(/^\/api\/bus\/(\d+)\/lock-seat$/);
      if (lockSeatMatch && request.method === 'POST') {
        const busId = lockSeatMatch[1];
        const body = await request.json();
        return await handleLockSeat(env, busId, body.seat, body.tripId || null, body.lockId || null);
      }

      // NEW: Unlock a seat (release hold)
      const unlockSeatMatch = pathname.match(/^\/api\/bus\/(\d+)\/unlock-seat$/);
      if (unlockSeatMatch && request.method === 'POST') {
        const busId = unlockSeatMatch[1];
        const body = await request.json();
        return await handleUnlockSeat(env, busId, body.seat, body.tripId || null, body.lockId || null);
      }

      // NEW: Confirm booking after Paystack payment
      if (pathname === '/api/booking/confirm' && request.method === 'POST') {
        const body = await request.json();
        return await handleBookingConfirm(env, body);
      }

      // PAYMENTS: Paystack webhook
      if (pathname === '/api/paystack/webhook' && request.method === 'POST') {
        return await handlePaystackWebhook(env, request);
      }

      // AUTH: Google OAuth
      if (pathname === '/api/auth/google' && request.method === 'POST') {
        const body = await request.json();
        return await handleGoogleAuth(env, body);
      }

      // AUTH: Email Sign In
      if (pathname === '/api/auth/signin' && request.method === 'POST') {
        const body = await request.json();
        return await handleEmailSignIn(env, body);
      }

      // AUTH: Email Sign Up
      if (pathname === '/api/auth/signup' && request.method === 'POST') {
        const body = await request.json();
        return await handleEmailSignUp(env, body);
      }

      // AUTH: Verify Token
      if (pathname === '/api/auth/verify' && request.method === 'POST') {
        const body = await request.json();
        return await handleVerifyToken(env, body.token);
      }

      // USER: Get user bookings
      if (pathname === '/api/user/bookings' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        return await handleGetUserBookings(env, token);
      }

      // USER: Get user profile + latest passenger contact details
      if (pathname === '/api/user/profile' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        return await handleGetUserProfile(env, token);
      }

      // ADMIN: Bootstrap dashboard stats
      if (pathname === '/api/admin/bootstrap' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        return await handleAdminBootstrap(env, token);
      }

      // ADMIN: Manual booking (no Paystack)
      if (pathname === '/api/admin/bookings/manual' && request.method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        const body = await request.json();
        return await handleAdminManualBooking(env, token, body);
      }

      // ADMIN: Upcoming schedule bookings with passenger details
      if (pathname === '/api/admin/bookings/upcoming' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        return await handleAdminUpcomingBookings(env, token, request);
      }

      // ADMIN: Fleet options for dropdowns
      if (pathname === '/api/admin/fleet/options' && request.method === 'GET') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        return await handleAdminFleetOptions(env, token);
      }

      // ADMIN: Add bus to fleet
      if (pathname === '/api/admin/buses' && request.method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        const body = await request.json();
        return await handleAdminCreateBus(env, token, body);
      }

      // ADMIN: Create/schedule trip
      if (pathname === '/api/admin/trips' && request.method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        const body = await request.json();
        return await handleAdminCreateTrip(env, token, body);
      }

      // ADMIN: End trip (remove from customer route listing, keep history)
      const endTripMatch = pathname.match(/^\/api\/admin\/trips\/(\d+)\/end$/);
      if (endTripMatch && request.method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        return await handleAdminEndTrip(env, token, Number(endTripMatch[1]));
      }

      return new Response('Not found', { status: 404, headers: corsHeaders() });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }
  }
};

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}

const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEY_BITS = 256;
const SALT_BYTES = 16;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let schemaInitPromise = null;

async function tableColumns(env, tableName) {
  const res = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set((res.results || []).map((r) => String(r.name || '').toLowerCase()));
}

async function ensureOperationalSchema(env) {
  if (schemaInitPromise) {
    await schemaInitPromise;
    return;
  }

  schemaInitPromise = (async () => {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS trip_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
        bus_id INTEGER NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
        departure_date TEXT,
        departure_time TEXT,
        price REAL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at DATETIME DEFAULT (datetime('now')),
        ended_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now'))
      )
    `).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_trip_schedules_status ON trip_schedules(status)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_trip_schedules_route ON trip_schedules(route_id)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_trip_schedules_bus ON trip_schedules(bus_id)').run();

    const bookingCols = await tableColumns(env, 'bookings');
    if (!bookingCols.has('trip_id')) {
      await env.DB.prepare('ALTER TABLE bookings ADD COLUMN trip_id INTEGER REFERENCES trip_schedules(id) ON DELETE SET NULL').run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_id)').run();
    }

    const lockCols = await tableColumns(env, 'seat_locks');
    if (!lockCols.has('trip_id')) {
      await env.DB.prepare('ALTER TABLE seat_locks ADD COLUMN trip_id INTEGER REFERENCES trip_schedules(id) ON DELETE CASCADE').run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_seat_locks_trip ON seat_locks(trip_id)').run();
    }
  })();

  try {
    await schemaInitPromise;
  } catch (err) {
    schemaInitPromise = null;
    throw err;
  }
}

async function resolveTripForBus(env, busId, tripId = null) {
  if (tripId) {
    const trip = await env.DB.prepare(`
      SELECT id, route_id, bus_id, departure_date, departure_time, price, status
      FROM trip_schedules
      WHERE id = ? AND bus_id = ?
      LIMIT 1
    `).bind(tripId, busId).first();
    if (!trip) throw new Error('Trip not found for bus');
    if (trip.status !== 'active') throw new Error('Trip is not active');
    return trip;
  }

  const activeTrip = await env.DB.prepare(`
    SELECT id, route_id, bus_id, departure_date, departure_time, price, status
    FROM trip_schedules
    WHERE bus_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).bind(busId).first();
  if (activeTrip) return activeTrip;

  return null;
}

function normalizeSeatNumberRaw(seatValue, capacity = 50) {
  if (seatValue === null || seatValue === undefined) return null;
  const raw = String(seatValue).trim().toUpperCase();
  if (!raw) return null;

  // Accept numeric seats like "38", "038", and tolerant "L38" from old UI labeling.
  const numeric = raw.match(/^L?0*(\d+)$/);
  if (numeric) {
    const n = Number(numeric[1]);
    if (!Number.isFinite(n) || n < 1 || n > Number(capacity || 50)) return null;
    return String(n);
  }

  // Backward compatibility for legacy seat keys like "A1", "B10".
  const legacy = raw.match(/^([A-Z])0*(\d{1,2})$/);
  if (legacy) {
    const row = legacy[1].charCodeAt(0) - 65;
    const col = Number(legacy[2]);
    if (row < 0 || col < 1 || col > 10) return null;
    const n = row * 10 + col;
    if (n < 1 || n > Number(capacity || 50)) return null;
    return String(n);
  }

  return null;
}

function canonicalSeatToLegacy(canonicalSeat) {
  const n = Number(canonicalSeat);
  if (!Number.isFinite(n) || n < 1) return null;
  const row = Math.floor((n - 1) / 10);
  const col = ((n - 1) % 10) + 1;
  return `${String.fromCharCode(65 + row)}${col}`;
}

function uniqueNormalizedSeatList(rows, capacity) {
  const out = new Set();
  for (const r of (rows || [])) {
    const key = normalizeSeatNumberRaw(r?.seat_number, capacity);
    if (key) out.add(key);
  }
  return [...out].sort((a, b) => Number(a) - Number(b));
}

async function getBusCapacity(env, busId) {
  const bus = await env.DB.prepare('SELECT capacity FROM buses WHERE id = ?').bind(busId).first();
  if (!bus) throw new Error('Bus not found');
  const cap = Number(bus.capacity || 0);
  return cap > 0 ? cap : 50;
}

async function listConfirmedSeatNumbersForBusTrip(env, busId, tripId, capacity) {
  const res = tripId
    ? await env.DB.prepare('SELECT seat_number FROM bookings WHERE bus_id = ? AND trip_id = ? AND status = "confirmed"').bind(busId, tripId).all()
    : await env.DB.prepare('SELECT seat_number FROM bookings WHERE bus_id = ? AND status = "confirmed"').bind(busId).all();
  return uniqueNormalizedSeatList(res.results || [], capacity);
}

async function listActiveLockedSeatNumbersForBusTrip(env, busId, tripId, capacity) {
  const res = tripId
    ? await env.DB.prepare('SELECT seat_number FROM seat_locks WHERE bus_id = ? AND trip_id = ? AND datetime(expires_at) > datetime("now")').bind(busId, tripId).all()
    : await env.DB.prepare('SELECT seat_number FROM seat_locks WHERE bus_id = ? AND datetime(expires_at) > datetime("now")').bind(busId).all();
  return uniqueNormalizedSeatList(res.results || [], capacity);
}

async function listActiveLocksForBusTrip(env, busId, tripId) {
  const res = tripId
    ? await env.DB.prepare('SELECT id, seat_number, locked_by, expires_at FROM seat_locks WHERE bus_id = ? AND trip_id = ? AND datetime(expires_at) > datetime("now")').bind(busId, tripId).all()
    : await env.DB.prepare('SELECT id, seat_number, locked_by, expires_at FROM seat_locks WHERE bus_id = ? AND datetime(expires_at) > datetime("now")').bind(busId).all();
  return res.results || [];
}

async function hasConfirmedSeat(env, busId, tripId, seatKey, capacity) {
  const seats = await listConfirmedSeatNumbersForBusTrip(env, busId, tripId, capacity);
  return seats.includes(String(seatKey));
}

async function hasActiveLockSeat(env, busId, tripId, seatKey, capacity) {
  const seats = await listActiveLockedSeatNumbersForBusTrip(env, busId, tripId, capacity);
  return seats.includes(String(seatKey));
}

async function findOwnedActiveLockForSeat(env, busId, tripId, lockId, seatKey, capacity) {
  const res = tripId
    ? await env.DB.prepare('SELECT id, seat_number FROM seat_locks WHERE bus_id = ? AND trip_id = ? AND locked_by = ? AND datetime(expires_at) > datetime("now")').bind(busId, tripId, lockId).all()
    : await env.DB.prepare('SELECT id, seat_number FROM seat_locks WHERE bus_id = ? AND locked_by = ? AND datetime(expires_at) > datetime("now")').bind(busId, lockId).all();
  const rows = res.results || [];
  return rows.find((r) => normalizeSeatNumberRaw(r.seat_number, capacity) === String(seatKey)) || null;
}

async function insertConfirmedBookingAtomic(env, payload) {
  const {
    passengerId, busId, tripId = null, seatNumber, legacySeatNumber = null, pricePaid, externalRef
  } = payload;

  const runRes = await env.DB.prepare(`
    INSERT INTO bookings (passenger_id, bus_id, trip_id, seat_number, price_paid, status, external_ref)
    SELECT ?, ?, ?, ?, ?, 'confirmed', ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM bookings
      WHERE bus_id = ?
        AND COALESCE(trip_id, -1) = COALESCE(?, -1)
        AND (seat_number = ? OR seat_number = ?)
        AND status = 'confirmed'
    )
  `).bind(
    passengerId, busId, tripId, seatNumber, pricePaid, externalRef,
    busId, tripId, seatNumber, legacySeatNumber || seatNumber
  ).run();

  const inserted = Number(runRes?.meta?.changes || 0) > 0;
  if (!inserted) return { inserted: false, bookingId: null };
  return { inserted: true, bookingId: Number(runRes?.meta?.last_row_id || 0) || null };
}

async function handleGetRoutes(env){
  // Load route groups first
  const groupsRes = await env.DB.prepare('SELECT id, key, name, description FROM route_groups').all();
  const groups = groupsRes.results || [];
  const out = {};

  // If trips are scheduled, customer routes should show only active trips.
  const activeTripsRes = await env.DB.prepare(`
    SELECT
      ts.id as trip_id,
      ts.route_id,
      ts.departure_date,
      ts.departure_time,
      ts.price as trip_price,
      b.id as bus_id,
      b.name as bus_name,
      b.plate_number,
      b.capacity,
      b.available_seats,
      b.price as bus_price,
      b.route_text
    FROM trip_schedules ts
    JOIN buses b ON b.id = ts.bus_id
    WHERE ts.status = 'active'
    ORDER BY ts.id DESC
  `).all();
  const activeTrips = activeTripsRes.results || [];
  const tripCountRes = await env.DB.prepare('SELECT COUNT(*) as c FROM trip_schedules').first();
  const hasTripMode = Number(tripCountRes?.c || 0) > 0;

  for (const g of groups) {
    const routesRes = await env.DB.prepare('SELECT id, name, description FROM routes WHERE group_id = ?').bind(g.id).all();
    const routeRows = routesRes.results || [];
    const routes = [];

    for (const r of routeRows) {
      let buses = [];

      if (hasTripMode) {
        const routeTrips = activeTrips.filter((t) => Number(t.route_id) === Number(r.id));
        for (const t of routeTrips) {
          const counts = await env.DB.prepare(`
            SELECT
              (SELECT COUNT(*) FROM bookings WHERE bus_id = ? AND trip_id = ? AND status = 'confirmed') as booked_count,
              (SELECT COUNT(*) FROM seat_locks WHERE bus_id = ? AND trip_id = ? AND datetime(expires_at) > datetime('now')) as locked_count
          `).bind(t.bus_id, t.trip_id, t.bus_id, t.trip_id).first();

          const capacity = Number(t.capacity || 0);
          const booked = Number(counts?.booked_count || 0);
          const locked = Number(counts?.locked_count || 0);
          const computedAvailable = Math.max(0, capacity - booked - locked);

          buses.push({
            id: t.bus_id,
            tripId: t.trip_id,
            name: t.bus_name,
            plate_number: t.plate_number,
            capacity,
            availableSeats: computedAvailable,
            price: Number(t.trip_price ?? t.bus_price ?? 0),
            route: t.route_text || r.name,
            departure_date: t.departure_date || null,
            departure_time: t.departure_time || null
          });
        }
      } else {
        // Backward-compatible behavior when no active trips are configured.
        const busesRes = await env.DB.prepare(`
          SELECT id, name, plate_number, capacity, available_seats as availableSeats, price, route_text as route
          FROM buses WHERE route_id = ?
        `).bind(r.id).all();
        buses = busesRes.results || [];
      }

      routes.push({
        id: r.id,
        name: r.name,
        description: r.description,
        buses
      });
    }

    const outKey = (g.key && g.key.toLowerCase()) || g.name.toLowerCase().replace(/\s+/g, '_');
    out[outKey] = routes;
  }

  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function handleGetPassengers(env, request){
  // Return a paginated list; accept ?limit and ?offset
  const url = new URL(request.url);
  const q = new URLSearchParams(url.search);
  const limit = parseInt(q.get('limit')) || 100;
  const offset = parseInt(q.get('offset')) || 0;
  
  // simple query returning basic passenger info with pagination
  const stmt = 'SELECT id, first_name, last_name, email, phone, next_of_kin_name, next_of_kin_phone, created_at FROM passengers ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const res = await env.DB.prepare(stmt).bind(limit, offset).all();
  const rows = res.results || [];
  return new Response(JSON.stringify({ passengers: rows, limit, offset }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

// NEW: Get seat availability (available, locked, booked)
async function handleGetBusSeats(env, busId, request) {
  try {
    const url = new URL(request.url);
    const tripIdParam = Number(url.searchParams.get('tripId') || 0);
    const tripId = Number.isFinite(tripIdParam) && tripIdParam > 0 ? tripIdParam : null;
    const ownLockId = String(url.searchParams.get('lockId') || '').trim() || null;
    const trip = await resolveTripForBus(env, busId, tripId);

    const capacity = await getBusCapacity(env, busId);

    // Numeric seat keys: "1" ... "capacity"
    const allSeats = [];
    for (let i = 0; i < capacity; i++) {
      allSeats.push(String(i + 1));
    }

    const bookedSeats = await listConfirmedSeatNumbersForBusTrip(env, busId, trip?.id || null, capacity);
    const activeLocks = await listActiveLocksForBusTrip(env, busId, trip?.id || null);
    const ownLockedSet = new Set();
    const lockedByOthersSet = new Set();
    for (const l of activeLocks) {
      const k = normalizeSeatNumberRaw(l.seat_number, capacity);
      if (!k) continue;
      if (ownLockId && String(l.locked_by || '') === ownLockId) ownLockedSet.add(k);
      else lockedByOthersSet.add(k);
    }
    const ownLocked = [...ownLockedSet].sort((a, b) => Number(a) - Number(b));
    const lockedSeats = [...lockedByOthersSet].sort((a, b) => Number(a) - Number(b));
    const bookedSet = new Set(bookedSeats);
    const lockedSet = new Set(lockedSeats);

    // Available for this caller = all seats not booked and not locked by others.
    // Seats held by this caller are exposed via own_locked.
    const available = allSeats.filter((s) => !bookedSet.has(s) && !lockedSet.has(s));

    return new Response(JSON.stringify({
      trip_id: trip?.id || null,
      available,
      locked: lockedSeats,
      own_locked: ownLocked,
      booked: bookedSeats
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// NEW: Lock a seat (insert into seat_locks with expiry)
async function handleLockSeat(env, busId, seat, tripId = null, lockId = null) {
  try {
    const trip = await resolveTripForBus(env, busId, tripId ? Number(tripId) : null);
    const tripKey = trip?.id || null;
    const capacity = await getBusCapacity(env, busId);
    const seatKey = normalizeSeatNumberRaw(seat, capacity);
    if (!seatKey) throw new Error('Invalid seat number');
    const legacySeat = canonicalSeatToLegacy(seatKey) || seatKey;
    const requestedLockId = String(lockId || '').trim() || null;
    const lockOwner = requestedLockId || `lock_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // Cleanup only this seat's expired locks (canonical + legacy formats).
    await env.DB.prepare(`
      DELETE FROM seat_locks
      WHERE bus_id = ?
        AND (seat_number = ? OR seat_number = ?)
        AND datetime(expires_at) <= datetime("now")
    `).bind(busId, seatKey, legacySeat).run();
    if (tripKey) {
      await env.DB.prepare(`
        DELETE FROM seat_locks
        WHERE bus_id = ?
          AND (seat_number = ? OR seat_number = ?)
          AND (trip_id IS NULL OR trip_id != ?)
      `).bind(busId, seatKey, legacySeat, tripKey).run();
    }

    // Check if seat is already locked by another user.
    const activeLocks = await listActiveLocksForBusTrip(env, busId, tripKey);
    const matchingLock = activeLocks.find((l) => {
      const k = normalizeSeatNumberRaw(l.seat_number, capacity);
      return k === seatKey;
    });
    if (matchingLock && String(matchingLock.locked_by || '') !== lockOwner) {
      throw new Error('Seat already locked by another user');
    }
    if (await hasConfirmedSeat(env, busId, tripKey, seatKey, capacity)) {
      throw new Error('Seat already booked');
    }

    // Create lock with 5-minute expiry
    const expiryRes = await env.DB.prepare(`SELECT datetime('now', '+5 minutes') as expires_at`).first();
    const expiresAt = expiryRes?.expires_at || new Date(Date.now() + 5 * 60 * 1000).toISOString();

    if (matchingLock) {
      await env.DB.prepare('UPDATE seat_locks SET expires_at = ? WHERE id = ?').bind(expiresAt, matchingLock.id).run();
    } else {
      await env.DB.prepare('INSERT INTO seat_locks (bus_id, trip_id, seat_number, locked_by, expires_at) VALUES (?, ?, ?, ?, ?)').bind(busId, tripKey, seatKey, lockOwner, expiresAt).run();
    }

    return new Response(JSON.stringify({
      lock_id: lockOwner,
      trip_id: tripKey,
      seat: seatKey,
      expires_at: expiresAt
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// NEW: Confirm booking after Paystack payment
async function handleBookingConfirm(env, data) {
  try {
    const { firstName, lastName, email, phone, nokName, nokPhone, seat, seats, busId, price, unitPrice, lockId, paystackRef, tripId } = data;
    const trip = await resolveTripForBus(env, busId, tripId ? Number(tripId) : null);
    const tripKey = trip?.id || null;
    const capacity = await getBusCapacity(env, busId);
    const rawSeatList = Array.isArray(seats) && seats.length ? seats : (seat !== undefined && seat !== null ? [seat] : []);
    if (!rawSeatList.length) throw new Error('Seat selection is required');
    const seatKeys = [];
    for (const rawSeat of rawSeatList) {
      const seatKey = normalizeSeatNumberRaw(rawSeat, capacity);
      if (!seatKey) throw new Error('Invalid seat number');
      if (!seatKeys.includes(seatKey)) seatKeys.push(seatKey);
    }
    if (!seatKeys.length) throw new Error('Seat selection is required');

    if (!paystackRef) throw new Error('Payment reference is required');

    // Idempotency: if this payment reference already created one or more bookings, return them.
    const existingRes = await env.DB.prepare(`
      SELECT b.id, b.seat_number, b.price_paid, buses.name as bus_name, r.name as route_name, buses.capacity as bus_capacity
      FROM bookings b
      JOIN buses ON buses.id = b.bus_id
      JOIN routes r ON r.id = buses.route_id
      WHERE b.external_ref = ? OR b.external_ref LIKE ?
      ORDER BY b.id ASC
    `).bind(paystackRef, `${paystackRef}:%`).all();
    const existingRows = existingRes.results || [];
    if (existingRows.length) {
      const existingReceipt = await getReceiptByBookingId(env, existingRows[0].id);
      const normalizedSeats = existingRows
        .map((r) => normalizeSeatNumberRaw(r.seat_number, Number(r.bus_capacity || capacity)) || String(r.seat_number))
        .filter(Boolean);
      const seatText = normalizedSeats.join(', ');
      const totalPaid = existingRows.reduce((sum, r) => sum + Number(r.price_paid || 0), 0);
      return new Response(JSON.stringify({
        booking_id: `ELITE-${existingRows[0].id}`,
        booking_ids: existingRows.map((r) => `ELITE-${r.id}`),
        passenger_name: `${firstName} ${lastName}`,
        route_name: existingRows[0].route_name,
        bus_name: existingRows[0].bus_name,
        seat: seatText,
        seats: normalizedSeats,
        seat_count: normalizedSeats.length,
        price: totalPaid,
        phone,
        email,
        status: 'confirmed',
        duplicate: true,
        receipt_url: existingReceipt?.receipt_url || null
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    // Verify Paystack transaction server-side before creating booking.
    const verification = await verifyPaystackTransaction(env, paystackRef);
    if (!verification.verified) throw new Error('Payment verification failed');
    if (verification.status !== 'success') throw new Error('Payment not successful');
    if (Number.isFinite(Number(price))) {
      const expectedKobo = Math.round(Number(price) * 100);
      if (verification.amountKobo !== expectedKobo) {
        throw new Error('Payment amount mismatch');
      }
    }

    // Validate all seat locks still exist and are owned by this lock session.
    const ownedLocks = [];
    for (const seatKey of seatKeys) {
      const lock = await findOwnedActiveLockForSeat(env, busId, tripKey, lockId, seatKey, capacity);
      if (!lock) throw new Error(`Seat lock expired or invalid for seat ${seatKey}`);
      ownedLocks.push(lock);
    }

    // Create passenger record
    const passengerRes = await env.DB.prepare('INSERT INTO passengers (first_name, last_name, email, phone, next_of_kin_name, next_of_kin_phone) VALUES (?, ?, ?, ?, ?, ?)').bind(firstName, lastName, email, phone, nokName, nokPhone).run();
    const passengerId = passengerRes.meta.last_row_id;

    const totalPaid = Number.isFinite(Number(price)) ? Number(price) : 0;
    const perSeatFromInput = Number(unitPrice);
    const perSeatPaid = Number.isFinite(perSeatFromInput) && perSeatFromInput > 0
      ? perSeatFromInput
      : (seatKeys.length ? (totalPaid / seatKeys.length) : totalPaid);

    // Create confirmed bookings atomically (one row per seat).
    const createdBookingIds = [];
    for (const seatKey of seatKeys) {
      const legacySeat = canonicalSeatToLegacy(seatKey) || seatKey;
      const externalRef = seatKeys.length === 1 ? paystackRef : `${paystackRef}:${seatKey}`;
      const bookingInsert = await insertConfirmedBookingAtomic(env, {
        passengerId,
        busId,
        tripId: tripKey,
        seatNumber: seatKey,
        legacySeatNumber: legacySeat,
        pricePaid: perSeatPaid,
        externalRef
      });
      if (!bookingInsert.inserted) {
        for (const bookingId of createdBookingIds) {
          await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(bookingId).run();
        }
        await env.DB.prepare('DELETE FROM passengers WHERE id = ?').bind(passengerId).run();
        throw new Error(`Seat already booked: ${seatKey}`);
      }
      createdBookingIds.push(bookingInsert.bookingId);
    }
    const bookingId = createdBookingIds[0];

    // Remove all consumed seat locks
    for (const lock of ownedLocks) {
      await env.DB.prepare('DELETE FROM seat_locks WHERE id = ?').bind(lock.id).run();
    }
    if (tripKey) {
      const busCap = await env.DB.prepare('SELECT capacity FROM buses WHERE id = ?').bind(busId).first();
      const count = await env.DB.prepare('SELECT COUNT(*) as c FROM bookings WHERE bus_id = ? AND trip_id = ? AND status = "confirmed"').bind(busId, tripKey).first();
      const remaining = Math.max(0, Number(busCap?.capacity || 0) - Number(count?.c || 0));
      await env.DB.prepare('UPDATE buses SET available_seats = ? WHERE id = ?').bind(remaining, busId).run();
    }

    // Get bus and route info for receipt
    const busInfo = await env.DB.prepare('SELECT name, route_id FROM buses WHERE id = ?').bind(busId).first();
    const busName = busInfo?.name || 'Unknown Bus';
    
    // Get actual route name
    let routeName = 'Route';
    const routeIdForBooking = trip?.route_id || busInfo?.route_id || null;
    if (routeIdForBooking) {
      const routeInfo = await env.DB.prepare('SELECT name FROM routes WHERE id = ?').bind(routeIdForBooking).first();
      routeName = routeInfo?.name || 'Route';
    }

    // Generate/send receipt + admin notice via GAS (if configured)
    const gasResult = await sendBookingToGAS(env, {
      bookingId,
      passengerName: `${firstName} ${lastName}`,
      firstName,
      lastName,
      routeName,
      busName,
      seat: seatKeys.join(', '),
      amount: totalPaid,
      phone,
      email,
      paystackRef,
      source: 'customer_paystack',
      seatCount: seatKeys.length
    });

    const receiptUrl = gasResult?.receipt_url || gasResult?.receiptUrl || null;
    if (receiptUrl) {
      for (const id of createdBookingIds) {
        await saveReceiptForBooking(env, id, receiptUrl, gasResult?.drive_file_id || gasResult?.driveFileId || null);
      }
    }

    // Send SMS via Arkesel (include receipt link when available)
    const seatText = seatKeys.join(', ');
    const smsText = receiptUrl
      ? `Your Elite Transport booking is confirmed! Booking ID: ELITE-${bookingId}, Seat(s): ${seatText}, Amount: GHS ${totalPaid.toFixed(2)}. Receipt: ${receiptUrl}`
      : `Your Elite Transport booking is confirmed! Booking ID: ELITE-${bookingId}, Seat(s): ${seatText}, Amount: GHS ${totalPaid.toFixed(2)}`;
    await sendSMS(env, phone, smsText);

    // Return receipt data
    return new Response(JSON.stringify({
      booking_id: `ELITE-${bookingId}`,
      booking_ids: createdBookingIds.map((id) => `ELITE-${id}`),
      passenger_name: `${firstName} ${lastName}`,
      route_name: routeName,
      bus_name: busName,
      seat: seatText,
      seats: seatKeys,
      seat_count: seatKeys.length,
      price: totalPaid,
      phone,
      email,
      status: 'confirmed',
      receipt_url: receiptUrl
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

async function handleUnlockSeat(env, busId, seat, tripId = null, lockId = null) {
  try {
    const key = String(lockId || '').trim();
    if (!key) throw new Error('Lock ID required');

    const capacity = await getBusCapacity(env, busId);
    const seatKey = normalizeSeatNumberRaw(seat, capacity);
    if (!seatKey) throw new Error('Invalid seat number');
    const legacySeat = canonicalSeatToLegacy(seatKey) || seatKey;

    const trip = await resolveTripForBus(env, busId, tripId ? Number(tripId) : null);
    const tripKey = trip?.id || null;

    if (tripKey) {
      await env.DB.prepare(`
        DELETE FROM seat_locks
        WHERE bus_id = ?
          AND trip_id = ?
          AND locked_by = ?
          AND (seat_number = ? OR seat_number = ?)
      `).bind(busId, tripKey, key, seatKey, legacySeat).run();
    } else {
      await env.DB.prepare(`
        DELETE FROM seat_locks
        WHERE bus_id = ?
          AND locked_by = ?
          AND (seat_number = ? OR seat_number = ?)
      `).bind(busId, key, seatKey, legacySeat).run();
    }

    return new Response(JSON.stringify({
      unlocked: true,
      trip_id: tripKey,
      seat: seatKey
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// Send SMS notification via Arkesel
async function sendSMS(env, phone, message) {
  try {
    // Arkesel API endpoint
    const arkeselUrl = 'https://sms.arkesel.com/api/send';
    const apiKey = env.ARKESEL_API_KEY;
    const senderId = env.ARKESEL_SENDER_ID || 'EliteTransport';

    const params = new URLSearchParams({
      api_key: apiKey,
      to: phone,
      from: senderId,
      sms: message
    });

    const response = await fetch(arkeselUrl, {
      method: 'POST',
      body: params
    });

    const result = await response.json();
    return result.status === 'success' || response.ok;
  } catch (err) {
    return false;
  }
}

async function ensureReceiptStore(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS booking_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      receipt_url TEXT NOT NULL,
      drive_file_id TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    )
  `).run();
}

async function saveReceiptForBooking(env, bookingId, receiptUrl, driveFileId = null) {
  if (!bookingId || !receiptUrl) return;
  await ensureReceiptStore(env);
  await env.DB.prepare(`
    INSERT INTO booking_receipts (booking_id, receipt_url, drive_file_id)
    VALUES (?, ?, ?)
    ON CONFLICT(booking_id) DO UPDATE SET
      receipt_url = excluded.receipt_url,
      drive_file_id = excluded.drive_file_id
  `).bind(bookingId, receiptUrl, driveFileId).run();
}

async function getReceiptByBookingId(env, bookingId) {
  if (!bookingId) return null;
  await ensureReceiptStore(env);
  return await env.DB.prepare('SELECT receipt_url, drive_file_id FROM booking_receipts WHERE booking_id = ?').bind(bookingId).first();
}

// Sends booking payload to Google Apps Script for:
// 1) PDF receipt generation and Drive storage
// 2) Admin email notification
// Expected GAS response: { receipt_url, drive_file_id }
async function sendBookingToGAS(env, payload) {
  const webhookUrl = env.GAS_WEBHOOK_URL;
  if (!webhookUrl) return null;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'booking.confirmed',
        timestamp: new Date().toISOString(),
        ...payload
      })
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json().catch(() => null);
    return data;
  } catch (err) {
    return null;
  }
}

// Webhook fallback: when charge.success arrives and booking already exists,
// ensure receipt generation + one fallback SMS attempt (when no stored receipt yet).
async function handleWebhookBookingFallback(env, reference) {
  if (!reference) return;

  const booking = await env.DB.prepare(`
    SELECT
      b.id,
      b.seat_number,
      b.price_paid,
      b.external_ref,
      p.first_name,
      p.last_name,
      p.email,
      p.phone,
      buses.name as bus_name,
      buses.capacity as bus_capacity,
      r.name as route_name
    FROM bookings b
    JOIN passengers p ON p.id = b.passenger_id
    JOIN buses ON buses.id = b.bus_id
    LEFT JOIN trip_schedules ts ON ts.id = b.trip_id
    LEFT JOIN routes r ON r.id = COALESCE(ts.route_id, buses.route_id)
    WHERE b.external_ref = ? OR b.external_ref LIKE ?
    ORDER BY b.id DESC
    LIMIT 1
  `).bind(reference, `${reference}:%`).first();
  if (!booking) return;

  const existingReceipt = await getReceiptByBookingId(env, booking.id);
  let receiptUrl = existingReceipt?.receipt_url || null;
  const normalizedSeat = normalizeSeatNumberRaw(booking.seat_number, Number(booking.bus_capacity || 50)) || String(booking.seat_number);

  if (!receiptUrl) {
    const gasResult = await sendBookingToGAS(env, {
      bookingId: booking.id,
      passengerName: `${booking.first_name} ${booking.last_name}`,
      firstName: booking.first_name,
      lastName: booking.last_name,
      routeName: booking.route_name || 'Route',
      busName: booking.bus_name || 'Bus',
      seat: normalizedSeat,
      amount: Number(booking.price_paid || 0),
      phone: booking.phone,
      email: booking.email,
      paystackRef: booking.external_ref,
      source: 'paystack_webhook_fallback'
    });

    receiptUrl = gasResult?.receipt_url || gasResult?.receiptUrl || null;
    if (receiptUrl) {
      await saveReceiptForBooking(
        env,
        booking.id,
        receiptUrl,
        gasResult?.drive_file_id || gasResult?.driveFileId || null
      );
    }
  }

  // Fallback SMS should only run when there was no prior stored receipt record.
  // This avoids duplicate SMS for normal booking-confirmation flow.
  if (!existingReceipt) {
    const amount = Number(booking.price_paid || 0);
    const smsText = receiptUrl
      ? `Your Elite Transport booking is confirmed! Booking ID: ELITE-${booking.id}, Seat: ${normalizedSeat}, Amount: GHS ${amount.toFixed(2)}. Receipt: ${receiptUrl}`
      : `Your Elite Transport booking is confirmed! Booking ID: ELITE-${booking.id}, Seat: ${normalizedSeat}, Amount: GHS ${amount.toFixed(2)}`;
    await sendSMS(env, booking.phone, smsText);
  }
}

async function verifyPaystackTransaction(env, reference) {
  const secretKey = env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('Missing PAYSTACK_SECRET_KEY');

  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${secretKey}`
    }
  });

  if (!res.ok) {
    throw new Error(`Paystack verify failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  if (!body?.status || !body?.data) {
    throw new Error('Invalid Paystack verify response');
  }

  return {
    verified: true,
    status: body.data.status,
    amountKobo: Number(body.data.amount || 0),
    reference: body.data.reference
  };
}

function parseAdminEmails(env) {
  const raw = String(env.ADMIN_EMAILS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(env, email) {
  if (!email) return false;
  const admins = parseAdminEmails(env);
  return admins.includes(String(email).toLowerCase());
}

async function getSessionUser(env, token) {
  if (!token) throw new Error('Token required');

  const session = await env.DB.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?').bind(token).first();
  if (!session) throw new Error('Invalid token');

  const expiresAt = new Date(session.expires_at);
  if (expiresAt < new Date()) throw new Error('Token expired');

  const user = await env.DB.prepare('SELECT id, first_name, last_name, email, phone, picture_url, auth_method FROM users WHERE id = ?').bind(session.user_id).first();
  if (!user) throw new Error('User not found');

  return user;
}

async function hmacSha512Hex(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function handlePaystackWebhook(env, request) {
  try {
    const secretKey = env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      return new Response(JSON.stringify({ error: 'Missing PAYSTACK_SECRET_KEY' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-paystack-signature') || '';
    const expectedSignature = await hmacSha512Hex(secretKey, rawBody);

    if (!timingSafeEqual(signature, expectedSignature)) {
      return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const event = JSON.parse(rawBody);
    if (event?.event === 'charge.success') {
      const reference = event?.data?.reference;
      if (reference) {
        // Best-effort consistency update if booking exists with this reference.
        await env.DB.prepare('UPDATE bookings SET status = ? WHERE external_ref = ? OR external_ref LIKE ?').bind('confirmed', reference, `${reference}:%`).run();
        await handleWebhookBookingFallback(env, reference);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

// ==================== AUTHENTICATION ====================

// Generate a simple JWT-like token (in production, use proper JWT library)
function generateToken(userId) {
  const rand = new Uint8Array(24);
  crypto.getRandomValues(rand);
  return `tok_${userId}_${Date.now()}_${bytesToBase64(rand).replace(/[+/=]/g, '')}`;
}

// Password hash using PBKDF2; retains compatibility with legacy hash_ values.
async function hashPassword(password) {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BITS
  );
  const hash = new Uint8Array(bits);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  if (hash.startsWith('pbkdf2$')) {
    const parts = hash.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    const salt = base64ToBytes(parts[2]);
    const expected = base64ToBytes(parts[3]);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      expected.length * 8
    );
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  }
  return hash === ('hash_' + btoa(password));
}

// Google OAuth Handler
async function handleGoogleAuth(env, data) {
  try {
    const { googleId, email, firstName, lastName, picture, phone, nokName, nokPhone, mode = 'signin' } = data;

    if (!googleId || !email) throw new Error('Google identity is required');
    if (mode !== 'signin' && mode !== 'signup') throw new Error('Invalid auth mode');

    // Check if user exists by Google ID first, then by email (account linking).
    let user = await env.DB.prepare('SELECT id, first_name, last_name, email, google_id FROM users WHERE google_id = ?').bind(googleId).first();
    if (!user) {
      user = await env.DB.prepare('SELECT id, first_name, last_name, email, google_id FROM users WHERE email = ?').bind(email).first();
      if (user && !user.google_id) {
        await env.DB.prepare('UPDATE users SET google_id = ?, picture_url = ?, auth_method = ?, verified = 1 WHERE id = ?').bind(googleId, picture, 'google', user.id).run();
      }
    }

    // Returning users signing in should never be asked for contact fields again.
    if (mode === 'signin' && !user) {
      throw new Error('Account not found. Please create an account first.');
    }

    if (!user) {
      // New Google signup: collect contact details once during registration.
      if (!phone) throw new Error('Phone number is required for signup');

      const insertRes = await env.DB.prepare('INSERT INTO users (email, first_name, last_name, phone, google_id, picture_url, auth_method, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(email, firstName, lastName, phone, googleId, picture, 'google', 1).run();
      user = { id: insertRes.meta.last_row_id, first_name: firstName, last_name: lastName, email, google_id: googleId };

      await env.DB.prepare('INSERT INTO passengers (first_name, last_name, email, phone, next_of_kin_name, next_of_kin_phone) VALUES (?, ?, ?, ?, ?, ?)').bind(firstName, lastName, email, phone, nokName, nokPhone).run();
    }

    // Generate token
    const token = generateToken(user.id);

    // Store session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO auth_sessions (user_id, token, expires_at) VALUES (?, ?, ?)').bind(user.id, token, expiresAt).run();

    // Fetch full user data for response
    const fullUser = await env.DB.prepare('SELECT id, first_name, last_name, email, phone, picture_url, auth_method FROM users WHERE id = ?').bind(user.id).first();

    return new Response(JSON.stringify({
      token,
      user: {
        id: fullUser.id,
        name: `${fullUser.first_name} ${fullUser.last_name}`,
        email: fullUser.email,
        phone: fullUser.phone,
        picture: fullUser.picture_url,
        authMethod: fullUser.auth_method,
        isAdmin: isAdminEmail(env, fullUser.email)
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// Email Sign In
async function handleEmailSignIn(env, data) {
  try {
    const { email, password } = data;

    if (!email || !password) throw new Error('Email and password required');

    // Find user
    const user = await env.DB.prepare('SELECT id, password_hash, first_name, last_name FROM users WHERE email = ?').bind(email).first();
    if (!user) throw new Error('User not found');

    // Verify password
    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) throw new Error('Invalid password');

    // Generate token
    const token = generateToken(user.id);

    // Store session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO auth_sessions (user_id, token, expires_at) VALUES (?, ?, ?)').bind(user.id, token, expiresAt).run();

    // Fetch full user data for response
    const fullUser = await env.DB.prepare('SELECT phone, auth_method FROM users WHERE id = ?').bind(user.id).first();

    return new Response(JSON.stringify({
      token,
      user: {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        email,
        phone: fullUser.phone,
        authMethod: fullUser.auth_method,
        isAdmin: isAdminEmail(env, email)
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// Email Sign Up
async function handleEmailSignUp(env, data) {
  try {
    const { firstName, lastName, email, phone, password } = data;

    if (!firstName || !lastName || !email || !phone || !password) throw new Error('All fields required');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');

    // Check if user exists
    const existingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existingUser) throw new Error('User already exists');

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const insertRes = await env.DB.prepare('INSERT INTO users (email, first_name, last_name, phone, password_hash, auth_method) VALUES (?, ?, ?, ?, ?, ?)').bind(email, firstName, lastName, phone, passwordHash, 'email').run();
    const userId = insertRes.meta.last_row_id;

    // Create passenger record
    await env.DB.prepare('INSERT INTO passengers (first_name, last_name, email, phone) VALUES (?, ?, ?, ?)').bind(firstName, lastName, email, phone).run();

    // Generate token
    const token = generateToken(userId);

    // Store session
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO auth_sessions (user_id, token, expires_at) VALUES (?, ?, ?)').bind(userId, token, expiresAt).run();

    return new Response(JSON.stringify({
      token,
      user: {
        id: userId,
        name: `${firstName} ${lastName}`,
        email,
        phone,
        authMethod: 'email',
        isAdmin: isAdminEmail(env, email)
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// Verify Token
async function handleVerifyToken(env, token) {
  try {
    if (!token) throw new Error('Token required');

    // Check if token exists in sessions
    const session = await env.DB.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?').bind(token).first();
    if (!session) throw new Error('Invalid token');

    // Check expiry
    const expiresAt = new Date(session.expires_at);
    if (expiresAt < new Date()) throw new Error('Token expired');

    // Get user
    const user = await env.DB.prepare('SELECT id, first_name, last_name, email FROM users WHERE id = ?').bind(session.user_id).first();

    return new Response(JSON.stringify({
      valid: true,
      user: {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        isAdmin: isAdminEmail(env, user.email)
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: String(err) }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// Get user's booking history
async function handleGetUserBookings(env, token) {
  try {
    if (!token) throw new Error('Token required');

    // Verify token and get user ID
    const session = await env.DB.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token = ?').bind(token).first();
    if (!session) throw new Error('Invalid token');

    const expiresAt = new Date(session.expires_at);
    if (expiresAt < new Date()) throw new Error('Token expired');

    const userId = session.user_id;

    // Get all bookings for this user
    const bookingsRes = await env.DB.prepare(`
      SELECT 
        b.id,
        b.seat_number,
        b.price_paid,
        b.status,
        b.created_at,
        buses.name as bus_name,
        buses.id as bus_id,
        buses.capacity as bus_capacity,
        r.name as route_name,
        p.first_name,
        p.last_name
      FROM bookings b
      JOIN buses ON b.bus_id = buses.id
      JOIN routes r ON buses.route_id = r.id
      JOIN passengers p ON b.passenger_id = p.id
      WHERE p.id IN (
        SELECT id FROM passengers WHERE email = (SELECT email FROM users WHERE id = ?)
      )
      ORDER BY b.created_at DESC
      LIMIT 50
    `).bind(userId).all();

    const bookings = (bookingsRes.results || []).map(b => ({
      id: b.id,
      bus_name: b.bus_name,
      route_name: b.route_name,
      seat_number: normalizeSeatNumberRaw(b.seat_number, Number(b.bus_capacity || 50)) || String(b.seat_number),
      price_paid: b.price_paid,
      status: b.status,
      created_at: b.created_at
    }));

    return new Response(JSON.stringify({
      bookings
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

// Get user's profile and latest passenger contact details (for booking prefill)
async function handleGetUserProfile(env, token) {
  try {
    const user = await getSessionUser(env, token);

    const passenger = await env.DB.prepare(`
      SELECT
        first_name,
        last_name,
        email,
        phone,
        COALESCE(
          NULLIF(TRIM(next_of_kin_name), ''),
          (
            SELECT p2.next_of_kin_name
            FROM passengers p2
            WHERE p2.email = ?
              AND NULLIF(TRIM(p2.next_of_kin_name), '') IS NOT NULL
            ORDER BY p2.created_at DESC
            LIMIT 1
          )
        ) as next_of_kin_name,
        COALESCE(
          NULLIF(TRIM(next_of_kin_phone), ''),
          (
            SELECT p3.next_of_kin_phone
            FROM passengers p3
            WHERE p3.email = ?
              AND NULLIF(TRIM(p3.next_of_kin_phone), '') IS NOT NULL
            ORDER BY p3.created_at DESC
            LIMIT 1
          )
        ) as next_of_kin_phone,
        created_at
      FROM passengers
      WHERE email = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(user.email, user.email, user.email).first();

    return new Response(JSON.stringify({
      user: {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        phone: user.phone,
        picture: user.picture_url,
        authMethod: user.auth_method,
        isAdmin: isAdminEmail(env, user.email)
      },
      passenger: passenger ? {
        firstName: passenger.first_name,
        lastName: passenger.last_name,
        email: passenger.email,
        phone: passenger.phone,
        nokName: passenger.next_of_kin_name,
        nokPhone: passenger.next_of_kin_phone
      } : null
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
  }
}

async function handleAdminBootstrap(env, token) {
  try {
    const user = await getSessionUser(env, token);
    if (!isAdminEmail(env, user.email)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const [routesCount, busesCount, usersCount, bookingsCount, confirmedCount, pendingCount, revenue] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM routes').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM buses').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM users').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM bookings').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM bookings WHERE status = "confirmed"').first(),
      env.DB.prepare('SELECT COUNT(*) as c FROM bookings WHERE status = "pending"').first(),
      env.DB.prepare('SELECT COALESCE(SUM(price_paid), 0) as total FROM bookings WHERE status = "confirmed"').first()
    ]);

    await ensureReceiptStore(env);

    const recentBookingsRes = await env.DB.prepare(`
      SELECT b.id, b.seat_number, b.price_paid, b.status, b.created_at,
             buses.name as bus_name, buses.capacity as bus_capacity, r.name as route_name,
             p.first_name, p.last_name,
             br.receipt_url
      FROM bookings b
      JOIN buses ON buses.id = b.bus_id
      JOIN routes r ON r.id = buses.route_id
      JOIN passengers p ON p.id = b.passenger_id
      LEFT JOIN booking_receipts br ON br.booking_id = b.id
      ORDER BY b.created_at DESC
      LIMIT 8
    `).all();

    return new Response(JSON.stringify({
      admin: {
        email: user.email,
        name: `${user.first_name} ${user.last_name}`
      },
      summary: {
        routes: Number(routesCount?.c || 0),
        buses: Number(busesCount?.c || 0),
        users: Number(usersCount?.c || 0),
        bookings: Number(bookingsCount?.c || 0),
        confirmedBookings: Number(confirmedCount?.c || 0),
        pendingBookings: Number(pendingCount?.c || 0),
        revenue: Number(revenue?.total || 0)
      },
      recentBookings: (recentBookingsRes.results || []).map((b) => ({
        ...b,
        seat_number: normalizeSeatNumberRaw(b.seat_number, Number(b.bus_capacity || 50)) || String(b.seat_number)
      }))
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function handleAdminManualBooking(env, token, data) {
  try {
    const user = await getSessionUser(env, token);
    if (!isAdminEmail(env, user.email)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    const { firstName, lastName, email, phone, nokName, nokPhone, busId, seat, pricePaid, tripId } = data || {};
    if (!firstName || !lastName || !email || !phone || !busId || !seat) {
      throw new Error('Missing required fields');
    }

    const bus = await env.DB.prepare('SELECT id, name, route_id, price, capacity FROM buses WHERE id = ?').bind(busId).first();
    if (!bus) throw new Error('Bus not found');
    const trip = await resolveTripForBus(env, busId, tripId ? Number(tripId) : null);
    const tripKey = trip?.id || null;

    const seatKey = normalizeSeatNumberRaw(seat, Number(bus.capacity || 50));
    if (!seatKey) throw new Error('Invalid seat number');
    const legacySeat = canonicalSeatToLegacy(seatKey) || seatKey;

    if (await hasConfirmedSeat(env, busId, tripKey, seatKey, Number(bus.capacity || 50))) {
      throw new Error('Seat already booked');
    }

    if (await hasActiveLockSeat(env, busId, tripKey, seatKey, Number(bus.capacity || 50))) {
      throw new Error('Seat currently locked');
    }

    const passengerRes = await env.DB.prepare(
      'INSERT INTO passengers (first_name, last_name, email, phone, next_of_kin_name, next_of_kin_phone) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(firstName, lastName, email, phone, nokName || null, nokPhone || null).run();
    const passengerId = passengerRes.meta.last_row_id;

    const paid = Number.isFinite(Number(pricePaid)) ? Number(pricePaid) : Number(bus.price || 0);
    const extRef = `admin_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const bookingInsert = await insertConfirmedBookingAtomic(env, {
      passengerId,
      busId,
      tripId: tripKey,
      seatNumber: seatKey,
      legacySeatNumber: legacySeat,
      pricePaid: paid,
      externalRef: extRef
    });
    if (!bookingInsert.inserted) {
      await env.DB.prepare('DELETE FROM passengers WHERE id = ?').bind(passengerId).run();
      throw new Error('Seat already booked');
    }
    const bookingId = bookingInsert.bookingId;

    const route = await env.DB.prepare('SELECT name FROM routes WHERE id = ?').bind(trip?.route_id || bus.route_id).first();
    const routeName = route?.name || 'Route';

    const gasResult = await sendBookingToGAS(env, {
      bookingId,
      passengerName: `${firstName} ${lastName}`,
      firstName,
      lastName,
      routeName,
      busName: bus.name,
      seat: seatKey,
      amount: Number(paid),
      phone,
      email,
      paystackRef: null,
      source: 'admin_manual'
    });

    const receiptUrl = gasResult?.receipt_url || gasResult?.receiptUrl || null;
    if (receiptUrl) {
      await saveReceiptForBooking(env, bookingId, receiptUrl, gasResult?.drive_file_id || gasResult?.driveFileId || null);
    }

    const smsText = receiptUrl
      ? `Your Elite Transport booking is confirmed! Booking ID: ELITE-${bookingId}, Seat: ${seatKey}, Amount: GHS ${paid.toFixed(2)}. Receipt: ${receiptUrl}`
      : `Your Elite Transport booking is confirmed! Booking ID: ELITE-${bookingId}, Seat: ${seatKey}, Amount: GHS ${paid.toFixed(2)}`;
    await sendSMS(env, phone, smsText);

    if (tripKey) {
      const count = await env.DB.prepare('SELECT COUNT(*) as c FROM bookings WHERE bus_id = ? AND trip_id = ? AND status = "confirmed"').bind(busId, tripKey).first();
      const remaining = Math.max(0, Number(bus.capacity || 0) - Number(count?.c || 0));
      await env.DB.prepare('UPDATE buses SET available_seats = ? WHERE id = ?').bind(remaining, busId).run();
    }

    return new Response(JSON.stringify({
      booking_id: `ELITE-${bookingId}`,
      route_name: routeName,
      bus_name: bus.name,
      seat: seatKey,
      price: paid,
      status: 'confirmed',
      external_ref: extRef,
      receipt_url: receiptUrl
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function getBusesColumnSet(env) {
  const info = await env.DB.prepare('PRAGMA table_info(buses)').all();
  return new Set((info.results || []).map((r) => String(r.name || '').toLowerCase()));
}

async function handleAdminUpcomingBookings(env, token, request) {
  try {
    const user = await getSessionUser(env, token);
    if (!isAdminEmail(env, user.email)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    await ensureReceiptStore(env);

    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get('limit') || 200);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 1000)) : 200;
    const routeIdParam = Number(url.searchParams.get('routeId') || 0);
    const routeId = Number.isFinite(routeIdParam) && routeIdParam > 0 ? routeIdParam : null;
    const dateFrom = (url.searchParams.get('dateFrom') || '').trim();
    const dateTo = (url.searchParams.get('dateTo') || '').trim();
    const statusParam = (url.searchParams.get('status') || '').trim().toLowerCase();
    const allowedStatuses = new Set(['pending', 'confirmed', 'cancelled']);
    const status = allowedStatuses.has(statusParam) ? statusParam : null;

    const busCols = await getBusesColumnSet(env);
    const hasBusDepartureDate = busCols.has('departure_date');
    const hasBusDepartureTime = busCols.has('departure_time');
    const depDateExpr = hasBusDepartureDate ? 'COALESCE(ts.departure_date, buses.departure_date)' : 'ts.departure_date';
    const depTimeExpr = hasBusDepartureTime ? 'COALESCE(ts.departure_time, buses.departure_time)' : 'ts.departure_time';
    const hasAnyDeparture = true;

    let departureTsExpr = `datetime(${depDateExpr} || ' ' || COALESCE(${depTimeExpr}, '00:00:00'))`;
    const whereParts = [];
    const binds = [];
    whereParts.push('(ts.id IS NULL OR ts.status = "active")');
    whereParts.push(`(${depDateExpr} IS NULL OR ${departureTsExpr} >= datetime('now'))`);

    if (status) {
      whereParts.push('b.status = ?');
      binds.push(status);
    } else {
      whereParts.push('b.status != "cancelled"');
    }

    if (routeId) {
      whereParts.push('r.id = ?');
      binds.push(routeId);
    }

    if (dateFrom) {
      if (hasAnyDeparture) {
        whereParts.push(`date(${depDateExpr}) >= date(?)`);
      } else {
        whereParts.push('date(b.created_at) >= date(?)');
      }
      binds.push(dateFrom);
    }

    if (dateTo) {
      if (hasAnyDeparture) {
        whereParts.push(`date(${depDateExpr}) <= date(?)`);
      } else {
        whereParts.push('date(b.created_at) <= date(?)');
      }
      binds.push(dateTo);
    }

    const whereClause = whereParts.length ? whereParts.join(' AND ') : '1=1';

    const detailQuery = `
      SELECT
        b.id,
        b.status,
        b.seat_number,
        b.price_paid,
        b.created_at,
        buses.id as bus_id,
        buses.name as bus_name,
        buses.capacity as bus_capacity,
        ts.id as trip_id,
        r.id as route_id,
        r.name as route_name,
        p.first_name,
        p.last_name,
        p.email,
        p.phone,
        p.next_of_kin_name,
        p.next_of_kin_phone,
        br.receipt_url,
        ${depDateExpr} as departure_date,
        ${depTimeExpr} as departure_time,
        ${departureTsExpr} as departure_ts
      FROM bookings b
      JOIN buses ON buses.id = b.bus_id
      LEFT JOIN trip_schedules ts ON ts.id = b.trip_id
      JOIN routes r ON r.id = COALESCE(ts.route_id, buses.route_id)
      JOIN passengers p ON p.id = b.passenger_id
      LEFT JOIN booking_receipts br ON br.booking_id = b.id
      WHERE ${whereClause}
      ORDER BY
        CASE WHEN departure_ts IS NULL THEN 1 ELSE 0 END ASC,
        departure_ts ASC,
        b.created_at DESC
      LIMIT ?
    `;

    const bookingsRes = await env.DB.prepare(detailQuery).bind(...binds, limit).all();
    const bookings = bookingsRes.results || [];

    const summaryQuery = `
      SELECT
        COUNT(*) as total_bookings,
        COUNT(DISTINCT b.bus_id) as total_buses,
        COUNT(DISTINCT buses.route_id) as total_routes,
        COALESCE(SUM(b.price_paid), 0) as total_revenue
      FROM bookings b
      JOIN buses ON buses.id = b.bus_id
      LEFT JOIN trip_schedules ts ON ts.id = b.trip_id
      JOIN routes r ON r.id = COALESCE(ts.route_id, buses.route_id)
      WHERE ${whereClause}
    `;
    const summaryRes = await env.DB.prepare(summaryQuery).bind(...binds).first();

    const routesRes = await env.DB.prepare(`
      SELECT r.id, r.name, COUNT(b.id) as booking_count
      FROM routes r
      LEFT JOIN buses ON buses.route_id = r.id
      LEFT JOIN bookings b ON b.bus_id = buses.id AND b.status != 'cancelled'
      GROUP BY r.id, r.name
      ORDER BY r.name ASC
    `).all();

    const grouped = {};
    for (const row of bookings) {
      const key = String(row.route_id || 'unknown');
      if (!grouped[key]) {
        grouped[key] = {
          routeId: row.route_id,
          routeName: row.route_name,
          bookings: 0,
          passengers: []
        };
      }
      grouped[key].bookings += 1;
      grouped[key].passengers.push({
        bookingId: row.id,
        status: row.status,
        tripId: row.trip_id,
        busId: row.bus_id,
        busName: row.bus_name,
        seat: normalizeSeatNumberRaw(row.seat_number, Number(row.bus_capacity || 50)) || String(row.seat_number),
        pricePaid: Number(row.price_paid || 0),
        departureDate: row.departure_date || null,
        departureTime: row.departure_time || null,
        departureTs: row.departure_ts || null,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
        nextOfKinName: row.next_of_kin_name || null,
        nextOfKinPhone: row.next_of_kin_phone || null,
        receiptUrl: row.receipt_url || null
      });
    }

    return new Response(JSON.stringify({
      admin: {
        email: user.email,
        name: `${user.first_name} ${user.last_name}`
      },
      summary: {
        totalBookings: Number(summaryRes?.total_bookings || 0),
        totalRoutes: Number(summaryRes?.total_routes || 0),
        totalBuses: Number(summaryRes?.total_buses || 0),
        totalRevenue: Number(summaryRes?.total_revenue || 0),
        fallbackMode: false
      },
      filters: {
        routeId,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        status: status || 'all'
      },
      availableRoutes: (routesRes.results || []).map((r) => ({
        id: Number(r.id),
        name: r.name,
        bookings: Number(r.booking_count || 0)
      })),
      groupedByRoute: Object.values(grouped),
      bookings
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function requireAdminUser(env, token) {
  const user = await getSessionUser(env, token);
  if (!isAdminEmail(env, user.email)) throw new Error('Forbidden');
  return user;
}

async function handleAdminFleetOptions(env, token) {
  try {
    await requireAdminUser(env, token);

    const [routesRes, busesRes, activeTripsRes, recentTripsRes] = await Promise.all([
      env.DB.prepare('SELECT id, name FROM routes ORDER BY name ASC').all(),
      env.DB.prepare('SELECT id, name, plate_number, capacity, available_seats, route_id FROM buses ORDER BY id DESC').all(),
      env.DB.prepare(`
        SELECT ts.id, ts.route_id, ts.bus_id, ts.departure_date, ts.departure_time, ts.price, ts.status,
               r.name as route_name, b.name as bus_name, b.capacity,
               (SELECT COUNT(*) FROM bookings bk WHERE bk.trip_id = ts.id AND bk.status = 'confirmed') as booked_count
        FROM trip_schedules ts
        JOIN routes r ON r.id = ts.route_id
        JOIN buses b ON b.id = ts.bus_id
        WHERE ts.status = 'active'
        ORDER BY ts.id DESC
      `).all(),
      env.DB.prepare(`
        SELECT ts.id, ts.route_id, ts.bus_id, ts.departure_date, ts.departure_time, ts.price, ts.status, ts.ended_at,
               r.name as route_name, b.name as bus_name, b.capacity,
               (SELECT COUNT(*) FROM bookings bk WHERE bk.trip_id = ts.id AND bk.status = 'confirmed') as booked_count
        FROM trip_schedules ts
        JOIN routes r ON r.id = ts.route_id
        JOIN buses b ON b.id = ts.bus_id
        WHERE ts.status IN ('completed','cancelled')
        ORDER BY COALESCE(ts.ended_at, ts.created_at) DESC
        LIMIT 20
      `).all()
    ]);

    const activeTrips = (activeTripsRes.results || []).map((t) => ({
      id: t.id,
      routeId: t.route_id,
      routeName: t.route_name,
      busId: t.bus_id,
      busName: t.bus_name,
      capacity: Number(t.capacity || 0),
      bookedCount: Number(t.booked_count || 0),
      departureDate: t.departure_date,
      departureTime: t.departure_time,
      price: Number(t.price || 0),
      status: t.status,
      seatLeft: Math.max(0, Number(t.capacity || 0) - Number(t.booked_count || 0))
    }));

    const recentTrips = (recentTripsRes.results || []).map((t) => ({
      id: t.id,
      routeId: t.route_id,
      routeName: t.route_name,
      busId: t.bus_id,
      busName: t.bus_name,
      capacity: Number(t.capacity || 0),
      bookedCount: Number(t.booked_count || 0),
      departureDate: t.departure_date,
      departureTime: t.departure_time,
      price: Number(t.price || 0),
      status: t.status,
      endedAt: t.ended_at || null,
      seatLeft: Math.max(0, Number(t.capacity || 0) - Number(t.booked_count || 0))
    }));

    return new Response(JSON.stringify({
      routes: routesRes.results || [],
      buses: busesRes.results || [],
      activeTrips,
      recentTrips
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    const status = String(err).includes('Forbidden') ? 403 : 400;
    return new Response(JSON.stringify({ error: String(err) }), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function handleAdminCreateBus(env, token, data) {
  try {
    await requireAdminUser(env, token);
    const { name, plateNumber, routeId, capacity, availableSeats, price, routeText } = data || {};
    if (!name || !routeId) throw new Error('Bus name and route are required');

    const cap = Number(capacity || 0);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('Valid capacity required');
    const seats = Number.isFinite(Number(availableSeats)) ? Number(availableSeats) : cap;
    const safeSeats = Math.min(cap, Math.max(0, seats));
    const safePrice = Number.isFinite(Number(price)) ? Number(price) : 0;

    const insert = await env.DB.prepare(`
      INSERT INTO buses (route_id, name, plate_number, capacity, available_seats, price, route_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(routeId, name, plateNumber || null, cap, safeSeats, safePrice, routeText || null).run();

    return new Response(JSON.stringify({
      id: insert.meta.last_row_id,
      name,
      routeId: Number(routeId),
      capacity: cap,
      availableSeats: safeSeats,
      price: safePrice
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    const status = String(err).includes('Forbidden') ? 403 : 400;
    return new Response(JSON.stringify({ error: String(err) }), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function handleAdminCreateTrip(env, token, data) {
  try {
    await requireAdminUser(env, token);
    const { routeId, busId, departureDate, departureTime, price } = data || {};
    if (!routeId || !busId) throw new Error('Route and bus are required');
    const route = await env.DB.prepare('SELECT id FROM routes WHERE id = ?').bind(routeId).first();
    if (!route) throw new Error('Route not found');

    const bus = await env.DB.prepare('SELECT id, route_id, capacity, price FROM buses WHERE id = ?').bind(busId).first();
    if (!bus) throw new Error('Bus not found');

    const activeOnBus = await env.DB.prepare('SELECT id FROM trip_schedules WHERE bus_id = ? AND status = "active" LIMIT 1').bind(busId).first();
    if (activeOnBus) throw new Error('Bus already assigned to an active trip');

    const safePrice = Number.isFinite(Number(price)) ? Number(price) : Number(bus.price || 0);
    const insert = await env.DB.prepare(`
      INSERT INTO trip_schedules (route_id, bus_id, departure_date, departure_time, price, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).bind(routeId, busId, departureDate || null, departureTime || null, safePrice).run();
    const tripId = insert.meta.last_row_id;

    await env.DB.prepare('UPDATE buses SET route_id = ?, available_seats = ?, price = ? WHERE id = ?')
      .bind(routeId, Number(bus.capacity || 0), safePrice, busId).run();

    return new Response(JSON.stringify({
      tripId,
      routeId: Number(routeId),
      busId: Number(busId),
      departureDate: departureDate || null,
      departureTime: departureTime || null,
      price: safePrice,
      status: 'active'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    const status = String(err).includes('Forbidden') ? 403 : 400;
    return new Response(JSON.stringify({ error: String(err) }), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}

async function handleAdminEndTrip(env, token, tripId) {
  try {
    await requireAdminUser(env, token);
    if (!tripId) throw new Error('Trip ID required');

    const trip = await env.DB.prepare('SELECT id, bus_id, status FROM trip_schedules WHERE id = ?').bind(tripId).first();
    if (!trip) throw new Error('Trip not found');
    if (trip.status !== 'active') throw new Error('Trip is not active');

    const bus = await env.DB.prepare('SELECT id, capacity FROM buses WHERE id = ?').bind(trip.bus_id).first();
    await env.DB.prepare('UPDATE trip_schedules SET status = ?, ended_at = datetime("now") WHERE id = ?').bind('completed', tripId).run();
    await env.DB.prepare('UPDATE buses SET available_seats = ? WHERE id = ?').bind(Number(bus?.capacity || 0), trip.bus_id).run();
    await env.DB.prepare('DELETE FROM seat_locks WHERE trip_id = ?').bind(tripId).run();

    return new Response(JSON.stringify({
      tripId,
      status: 'completed',
      busId: trip.bus_id,
      availableSeats: Number(bus?.capacity || 0)
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  } catch (err) {
    const status = String(err).includes('Forbidden') ? 403 : 400;
    return new Response(JSON.stringify({ error: String(err) }), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }
}
