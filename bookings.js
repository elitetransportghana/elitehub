// bookings.js
// Handles seat selection, form submission, and Paystack payment flow

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const BOOKINGS_API_BASE = 'https://realeliteweb-app.elitetransportghana.workers.dev/api'; // Update to your Worker URL if needed
const PAYSTACK_KEY = 'pk_test_3cd2b822f4ec2dae7a1dd637562bc126151a27b6'; // Replace with your key
const PAYSTACK_CURRENCY = 'GHS';
const PAYSTACK_ALLOWED_CURRENCIES = new Set(['NGN', 'GHS', 'USD', 'ZAR', 'KES']);

let routeData = null;
let busData = null;
let selectedSeats = [];
let lockSessionId = null;
let pricePerSeat = 0;
let currentTripId = null;
let seatPollTimer = null;
let lockExpiryTimer = null;

function notify(type, message, duration = 3000) {
    if (window.toast && typeof window.toast[type] === 'function') {
        window.toast[type](message, duration);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](message);
}

function validatePaystackConfig() {
    if (!PAYSTACK_ALLOWED_CURRENCIES.has(PAYSTACK_CURRENCY)) {
        notify('error', `Unsupported checkout currency: ${PAYSTACK_CURRENCY}`);
        return false;
    }
    if (!/^pk_(test|live)_[a-zA-Z0-9]+$/.test(PAYSTACK_KEY)) {
        notify('error', 'Invalid Paystack public key configuration.');
        return false;
    }
    return true;
}

// On page load, retrieve route/bus data from sessionStorage or URL params
document.addEventListener('DOMContentLoaded', async () => {
    requireAuth(); // Require user to be logged in
    
    routeData = sessionStorage.getItem('selectedRoute') ? JSON.parse(sessionStorage.getItem('selectedRoute')) : null;
    busData = sessionStorage.getItem('selectedBus') ? JSON.parse(sessionStorage.getItem('selectedBus')) : null;

    if (!routeData || !busData) {
        notify('warning', 'Route or bus data not found. Please select from the routes page.');
        window.location.href = 'routes.html';
        return;
    }

    // Populate route details
    populateRouteDetails();

    // Prefill passenger details for logged-in users
    await prefillPassengerForm();
    
    // Render bus seat map
    await renderBusMap();
    updateSelectionDisplay();
    updatePrice();
    startSeatAvailabilityPolling();
    
    // Attach form submit handler
    document.getElementById('bookingForm').addEventListener('submit', handleBookingSubmit);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !lockSessionId) {
            renderBusMap(true).catch(() => {});
        }
    });

    window.addEventListener('beforeunload', () => {
        stopSeatAvailabilityPolling();
        clearLockExpiryTimer();
    });
});

function startSeatAvailabilityPolling() {
    stopSeatAvailabilityPolling();
    seatPollTimer = setInterval(() => {
        // Do not re-render while user is holding a seat lock.
        if (document.hidden || lockSessionId) return;
        renderBusMap(true).catch(() => {});
    }, 5000);
}

function stopSeatAvailabilityPolling() {
    if (!seatPollTimer) return;
    clearInterval(seatPollTimer);
    seatPollTimer = null;
}

function updateSelectionDisplay() {
    const seatDisplay = document.getElementById('selected-seat-display');
    if (!seatDisplay) return;
    if (!selectedSeats.length) {
        seatDisplay.textContent = 'None';
        return;
    }
    const sorted = [...selectedSeats].sort((a, b) => Number(a) - Number(b));
    seatDisplay.textContent = sorted.join(', ');
}

function clearLockExpiryTimer() {
    if (!lockExpiryTimer) return;
    clearTimeout(lockExpiryTimer);
    lockExpiryTimer = null;
}

function resetLockExpiryTimer() {
    clearLockExpiryTimer();
    lockExpiryTimer = setTimeout(async () => {
        if (!selectedSeats.length || !lockSessionId) return;
        notify('warning', 'Your seat hold has expired. Please select again.');
        selectedSeats = [];
        lockSessionId = null;
        updateSelectionDisplay();
        updatePrice();
        await renderBusMap(true);
    }, LOCK_TIMEOUT_MS);
}

function populateRouteDetails() {
    const unicodeArrow = String.fromCharCode(8594); // -> visual arrow
    const mojibakeArrow = '\u00e2\u2020\u2019'; // common broken encoding for arrow

    const rawRouteText = routeData.route || routeData.name || busData.route || '';
    const normalizedRoute = String(rawRouteText).replaceAll(mojibakeArrow, unicodeArrow);
    const routeParts = normalizedRoute.split(/(?:\u2192|->)/).map((s) => s.trim()).filter(Boolean);
    const from = routeData.from || routeParts[0] || 'Campus';
    const to = routeData.to || routeParts[1] || 'District';

    document.getElementById('route-from').textContent = from;
    document.getElementById('route-to').textContent = to;
    document.getElementById('bus-name').textContent = busData.name || busData.plate_number || 'Unknown Bus';
    document.getElementById('departure-date').textContent = busData.departure_date || busData.departureDate || 'TBD';
    document.getElementById('departure-time').textContent = busData.departure_time || busData.departureTime || 'TBD';

    pricePerSeat = parseFloat(busData.price ?? 0) || 0;
    document.getElementById('seat-price').textContent = `GHS ${pricePerSeat.toFixed(2)}`;
}

async function prefillPassengerForm() {
    const user = getCurrentUser ? getCurrentUser() : null;
    const token = getAuthToken ? getAuthToken() : localStorage.getItem('authToken');
    if (!user) return;

    let sourceUser = user;
    let sourcePassenger = null;

    if (token) {
        try {
            const res = await fetch(`${BOOKINGS_API_BASE}/user/profile`, {
                headers: { 'Authorization': `Bearer ${token}` },
                cache: 'no-store'
            });
            if (res.ok) {
                const data = await res.json();
                sourceUser = data.user || user;
                sourcePassenger = data.passenger || null;
            }
        } catch (err) {
            // silent fallback to locally cached user details
        }
    }

    const fullName = (sourceUser.name || '').trim();
    const nameParts = fullName ? fullName.split(/\s+/) : [];
    const firstName = nameParts.length ? nameParts[0] : '';
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    const firstNameInput = document.getElementById('first-name');
    const lastNameInput = document.getElementById('last-name');
    const emailInput = document.getElementById('email');
    const phoneInput = document.getElementById('phone');
    const nokNameInput = document.getElementById('nok-name');
    const nokPhoneInput = document.getElementById('nok-phone');

    if (firstNameInput && !firstNameInput.value) firstNameInput.value = sourcePassenger?.firstName || firstName;
    if (lastNameInput && !lastNameInput.value) lastNameInput.value = sourcePassenger?.lastName || lastName;
    if (emailInput && !emailInput.value) emailInput.value = sourcePassenger?.email || sourceUser.email || '';
    if (phoneInput && !phoneInput.value) phoneInput.value = sourcePassenger?.phone || sourceUser.phone || '';
    if (nokNameInput && !nokNameInput.value) nokNameInput.value = sourcePassenger?.nokName || '';
    if (nokPhoneInput && !nokPhoneInput.value) nokPhoneInput.value = sourcePassenger?.nokPhone || '';
}

async function renderBusMap(silent = false) {
    try {
        // Fetch current seat availability from backend
        currentTripId = Number(busData.tripId || busData.trip_id || 0) || null;
        const seatParams = new URLSearchParams();
        if (currentTripId) seatParams.set('tripId', String(currentTripId));
        if (lockSessionId) seatParams.set('lockId', lockSessionId);
        const seatUrl = `${BOOKINGS_API_BASE}/bus/${busData.id}/seats${seatParams.toString() ? `?${seatParams.toString()}` : ''}`;
        const res = await fetch(seatUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load seat map');
        
        const seatData = await res.json();
        if (seatData?.trip_id && !currentTripId) currentTripId = Number(seatData.trip_id);
        const availableSeats = seatData.available || [];
        const lockedSeats = seatData.locked || [];
        const ownLockedSeats = seatData.own_locked || [];
        const bookedSeats = seatData.booked || [];

        const layout = document.getElementById('bus-layout');
        layout.innerHTML = '';

        const seatNumToBackendLabel = (seatNum) => String(seatNum);
        const displaySeat = (seatNum) => String(seatNum).padStart(2, '0');

        // Geometry agreed with user:
        // F00: one seat [01]
        // R01-R06: 2+2
        // R07: left 2 seats + stairs on right
        // R08-R11: 2+2
        // R12: left 2 seats + two missing seats on right
        // R13: rear 5-seat row
        const seatRows = [
            [0, 1, 0, 0, 0],        // F00 (driver alignment)
            [2, 3, 'aisle', 4, 5],  // R01
            [6, 7, 'aisle', 8, 9],  // R02
            [10, 11, 'aisle', 12, 13], // R03
            [14, 15, 'aisle', 16, 17], // R04
            [18, 19, 'aisle', 20, 21], // R05
            [22, 23, 'aisle', 24, 25], // R06
            [26, 27, 'aisle', 'stairs', 'stairs'], // R07
            [28, 29, 'aisle', 30, 31], // R08
            [32, 33, 'aisle', 34, 35], // R09
            [36, 37, 'aisle', 38, 39], // R10
            [40, 41, 'aisle', 42, 43], // R11
            [44, 45, 'aisle', 'void', 'void'], // R12
            [46, 47, 48, 49, 50] // R13 (rear row)
        ];

        seatRows.forEach((rowDef, rowIndex) => {
            const row = document.createElement('div');
            row.className = 'bus-row';
            if (rowIndex === 13) row.classList.add('bus-row-rear');

            rowDef.forEach((slot) => {
                const slotEl = document.createElement('div');
                slotEl.className = 'bus-slot';

                if (slot === 0 || slot === 'void') {
                    slotEl.classList.add('void-slot');
                    row.appendChild(slotEl);
                    return;
                }

                if (slot === 'aisle') {
                    slotEl.classList.add('aisle-slot');
                    row.appendChild(slotEl);
                    return;
                }

                if (slot === 'stairs') {
                    slotEl.classList.add('stair-slot');
                    slotEl.setAttribute('aria-hidden', 'true');
                    row.appendChild(slotEl);
                    return;
                }

                const seatNum = Number(slot);
                const seatBackendLabel = seatNumToBackendLabel(seatNum);

                slotEl.classList.add('seat');
                slotEl.setAttribute('data-seat', seatBackendLabel);
                slotEl.textContent = displaySeat(seatNum);
                slotEl.title = `Seat ${displaySeat(seatNum)}`;

                if (bookedSeats.includes(seatBackendLabel)) {
                    slotEl.classList.add('occupied');
                    slotEl.style.cursor = 'not-allowed';
                } else if (lockedSeats.includes(seatBackendLabel)) {
                    slotEl.classList.add('locked');
                    slotEl.style.cursor = 'not-allowed';
                    slotEl.textContent = displaySeat(seatNum);
                } else {
                    if (selectedSeats.includes(seatBackendLabel) || ownLockedSeats.includes(seatBackendLabel)) {
                        slotEl.classList.add('selected');
                    }
                    slotEl.addEventListener('click', () => selectSeat(seatBackendLabel, slotEl));
                }

                row.appendChild(slotEl);
            });

            layout.appendChild(row);
        });
    } catch (err) {
        if (!silent) {
            notify('error', 'Failed to load seat availability. Please refresh.');
        }
    }
}

async function selectSeat(seatLabel, seatElement) {
    if (selectedSeats.includes(seatLabel)) {
        await unlockSeatSelection(seatLabel);
        selectedSeats = selectedSeats.filter((s) => s !== seatLabel);
        seatElement.classList.remove('selected');
        if (!selectedSeats.length) {
            lockSessionId = null;
            clearLockExpiryTimer();
        }
        updateSelectionDisplay();
        updatePrice();
        return;
    }

    // Lock seat on backend and add to selected set.
    try {
        const lockRes = await fetch(`${BOOKINGS_API_BASE}/bus/${busData.id}/lock-seat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seat: seatLabel,
                tripId: currentTripId || null,
                lockId: lockSessionId || null
            })
        });
        if (!lockRes.ok) throw new Error('Failed to lock seat');
        const { lock_id, trip_id } = await lockRes.json();
        lockSessionId = lock_id || lockSessionId;
        if (trip_id && !currentTripId) currentTripId = Number(trip_id);
        if (!selectedSeats.includes(seatLabel)) selectedSeats.push(seatLabel);

        seatElement.classList.add('selected');
        updateSelectionDisplay();
        updatePrice();
        resetLockExpiryTimer();
    } catch (err) {
        notify('error', 'Could not lock seat. Try again.');
        seatElement.classList.remove('selected');
        renderBusMap(true).catch(() => {});
    }
}

async function unlockSeatSelection(seatLabel) {
    if (!lockSessionId) return;
    try {
        await fetch(`${BOOKINGS_API_BASE}/bus/${busData.id}/unlock-seat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seat: seatLabel,
                tripId: currentTripId || null,
                lockId: lockSessionId
            })
        });
    } catch (err) {
        // best-effort unlock only
    }
}

function updatePrice() {
    if (selectedSeats.length && pricePerSeat > 0) {
        const total = pricePerSeat * selectedSeats.length;
        document.getElementById('total-price').textContent = `GHS ${total.toFixed(2)}`;
    } else {
        document.getElementById('total-price').textContent = 'GHS 0.00';
    }
}

async function handleBookingSubmit(e) {
    e.preventDefault();

    if (!selectedSeats.length) {
        notify('warning', 'Please select at least one seat.');
        return;
    }

    if (!lockSessionId) {
        notify('warning', 'Seat lock expired. Please select your seat(s) again.');
        return;
    }

    // Collect form data
    const totalPrice = pricePerSeat * selectedSeats.length;
    const formData = {
        firstName: document.getElementById('first-name').value,
        lastName: document.getElementById('last-name').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        nokName: document.getElementById('nok-name').value,
        nokPhone: document.getElementById('nok-phone').value,
        seats: [...selectedSeats],
        busId: busData.id,
        price: totalPrice,
        unitPrice: pricePerSeat,
        lockId: lockSessionId
    };
    if (currentTripId) formData.tripId = currentTripId;

    if (!formData.firstName || !formData.lastName || !formData.email || !formData.phone) {
        notify('warning', 'Please fill in all required fields.');
        return;
    }

    // Trigger Paystack payment
    initiatePaystackPayment(formData);
}

function initiatePaystackPayment(formData) {
    if (!validatePaystackConfig()) {
        return;
    }

    if (!Number.isFinite(formData.price) || formData.price <= 0) {
        notify('error', 'Invalid fare amount. Please reselect the trip.');
        return;
    }

    const onPaymentSuccess = (response) => {
        // Payment successful, confirm booking on backend
        confirmBookingWithBackend(formData, response.reference);
    };

    const handler = PaystackPop.setup({
        key: PAYSTACK_KEY,
        email: formData.email,
        amount: Math.round(formData.price * 100), // Paystack expects minor units
        currency: PAYSTACK_CURRENCY,
        ref: `ELITE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        onClose: () => {
            notify('info', 'Payment window closed.');
        },
        // Paystack Inline callback
        callback: onPaymentSuccess,
        // Backward-compatible alias used in some wrappers
        onSuccess: onPaymentSuccess
    });
    handler.openIframe();
}

async function confirmBookingWithBackend(formData, paystackRef) {
    try {
        const confirmRes = await fetch(`${BOOKINGS_API_BASE}/booking/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firstName: formData.firstName,
                lastName: formData.lastName,
                email: formData.email,
                phone: formData.phone,
                nokName: formData.nokName,
                nokPhone: formData.nokPhone,
                seat: formData.seats?.[0] || null,
                seats: formData.seats || [],
                busId: formData.busId,
                price: formData.price,
                unitPrice: formData.unitPrice,
                lockId: formData.lockId,
                tripId: formData.tripId || null,
                paystackRef: paystackRef
            })
        });

        if (!confirmRes.ok) {
            const errData = await confirmRes.json();
            throw new Error(errData.error || 'Failed to confirm booking');
        }

        const bookingConfirm = await confirmRes.json();

        // Immediately refresh seat map so confirmed seat shows as occupied on this page.
        selectedSeats = [];
        lockSessionId = null;
        clearLockExpiryTimer();
        updateSelectionDisplay();
        updatePrice();
        await renderBusMap(true);
        
        // Show receipt to customer
        displayReceipt(bookingConfirm);

        // Optionally clear sessionStorage
        sessionStorage.removeItem('selectedRoute');
        sessionStorage.removeItem('selectedBus');
    } catch (err) {
        notify('error', 'Booking confirmation failed: ' + err.message);
    }
}

function displayReceipt(bookingData) {
    const seatText = Array.isArray(bookingData.seats) && bookingData.seats.length
        ? bookingData.seats.join(', ')
        : (bookingData.seat || '-');
    const totalPaid = Number(bookingData.price || 0);
    const receiptButton = bookingData.receipt_url
        ? `<a href="${bookingData.receipt_url}" target="_blank" rel="noopener noreferrer" class="btn-primary btn-full" style="width:100%;padding:12px;border:none;cursor:pointer;margin-bottom:10px;text-align:center;display:inline-block;">Download PDF Receipt</a>`
        : '';

    const receiptHTML = `
        <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;">
            <div style="background:white;padding:40px;border-radius:12px;max-width:500px;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
                <div style="text-align:center;margin-bottom:30px;">
                    <i class="fa-solid fa-check-circle" style="font-size:3rem;color:var(--brand-dark);"></i>
                    <h2 style="color:var(--brand-dark);margin-top:15px;">Booking Confirmed!</h2>
                </div>
                <div style="background:var(--bg-light);padding:20px;border-radius:8px;margin-bottom:20px;">
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                        <span>Booking ID:</span>
                        <strong>${bookingData.booking_id}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                        <span>Passenger:</span>
                        <strong>${bookingData.passenger_name}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                        <span>Route:</span>
                        <strong>${bookingData.route_name}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                        <span>Bus:</span>
                        <strong>${bookingData.bus_name}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
                        <span>Seat(s):</span>
                        <strong>${seatText}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;border-top:1px solid #ddd;padding-top:10px;">
                        <span>Amount Paid:</span>
                        <strong style="color:var(--brand-dark);font-size:1.2rem;">GHS ${totalPaid.toFixed(2)}</strong>
                    </div>
                </div>
                <div style="background:#e8f5e9;padding:15px;border-radius:8px;margin-bottom:20px;font-size:0.9rem;">
                    <strong>âœ“ SMS confirmation sent to ${bookingData.phone}</strong>
                    <div style="color:var(--text-muted);margin-top:5px;">Your receipt has been sent. Please keep it for your reference.</div>
                </div>
                ${receiptButton}
                <button onclick="window.location.href='routes.html'" class="btn-primary btn-full" style="width:100%;padding:15px;border:none;cursor:pointer;">Back to Routes</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', receiptHTML);
}


