// profile.js
// Displays user profile and booking history

document.addEventListener('DOMContentLoaded', () => {
    requireAuth(); // Require user to be logged in
    loadProfileInfo();
    loadBookingHistory();
    
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('refresh-bookings-btn').addEventListener('click', loadBookingHistory);
});

function loadProfileInfo() {
    const user = getCurrentUser();
    
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    // Display user info
    document.getElementById('profile-name').textContent = user.name || '-';
    document.getElementById('profile-email').textContent = user.email || '-';
    document.getElementById('profile-phone').textContent = user.phone || '-';
    document.getElementById('profile-auth-method').textContent = capitalizeFirst(user.authMethod || 'email');

    // Display profile picture if available
    if (user.picture) {
        document.getElementById('profile-picture').innerHTML = `<img src="${user.picture}" style="width: 100%; height: 100%; object-fit: cover;" alt="Profile">`;
    }
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

async function loadBookingHistory() {
    const bookingsContainer = document.getElementById('bookings-list');
    const token = localStorage.getItem('authToken');

    if (!token) {
        bookingsContainer.innerHTML = '<div class="faded">Please log in to view your bookings.</div>';
        return;
    }

    try {
        bookingsContainer.innerHTML = '<div class="faded" style="text-align: center; padding: 40px 20px;"><i class="fa-solid fa-spinner" style="animation: spin 1s linear infinite; font-size: 2rem; margin-bottom: 10px;"></i><p>Loading bookings...</p></div>';

        const response = await fetch(`${API_BASE}/user/bookings`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const bookings = data.bookings || [];

        if (bookings.length === 0) {
            bookingsContainer.innerHTML = '<div class="faded" style="text-align: center; padding: 40px 20px;"><i class="fa-solid fa-calendar-x" style="font-size: 2rem; margin-bottom: 10px;"></i><p>No bookings yet. <a href="routes.html">Start booking now!</a></p></div>';
            return;
        }

        // Display bookings in table format
        let html = '<div class="booking-row-header"><div>Route</div><div>Bus</div><div>Seat</div><div>Price</div><div>Status</div></div>';
        
        bookings.forEach(booking => {
            const statusColor = booking.status === 'confirmed' ? 'green' : booking.status === 'pending' ? 'orange' : '#ccc';
            html += `
                <div class="booking-row">
                    <div><strong>${booking.route_name || 'Route'}</strong></div>
                    <div>${booking.bus_name || '-'}</div>
                    <div style="font-family: monospace; font-weight: 600;">${booking.seat_number || '-'}</div>
                    <div style="font-weight: 600;">GHS ${parseFloat(booking.price_paid || 0).toFixed(2)}</div>
                    <div style="padding: 4px 8px; background-color: ${statusColor}; color: white; border-radius: 4px; text-align: center; font-size: 0.85rem; font-weight: 600;">
                        ${capitalizeFirst(booking.status || 'unknown')}
                    </div>
                </div>
            `;
        });

        bookingsContainer.innerHTML = html;
    } catch (err) {
        bookingsContainer.innerHTML = `<div class="faded" style="color: #d32f2f;">Error loading bookings: ${err.message}</div>`;
    }
}
