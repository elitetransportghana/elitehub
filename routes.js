// routes.js
// Fetches route groups from a backend endpoint and renders them into the page.
// Configure the endpoint by setting `data-routes-endpoint` on <body> or edit API_URL below.

const API_URL_FALLBACK = 'https://realeliteweb-app.elitetransportghana.workers.dev/api/routes'; // replace with your Cloudflare Worker endpoint if needed

function formatCurrency(n){ return `GHS ${Number(n).toFixed(2)}`; }

function createBusItem(bus, routeName){
    const div = document.createElement('div');
    div.className = 'feature-card';
    div.style.marginBottom = '12px';
    const seatsLeft = Number(bus.availableSeats ?? bus.available_seats ?? 0);
    const status = seatsLeft > 0 ? 'Available' : 'Full';
    const isAvailable = status === 'Available';
    const seatChipClass = seatsLeft === 0 ? 'route-chip--full' : seatsLeft <= 5 ? 'route-chip--warn' : 'route-chip--ok';
    const seatChipText = seatsLeft === 0 ? 'Full' : seatsLeft <= 5 ? `${seatsLeft} seats left` : `${seatsLeft} seats open`;
    
    div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:20px;">
            <div style="flex:1;">
                <strong>${bus.name}</strong>
                <div style="font-size:0.9rem;color:var(--text-muted);">${bus.route || ''}</div>
                <div style="margin-top:10px;">
                    <span class="route-chip ${seatChipClass}">${seatChipText}</span>
                </div>
            </div>
            <div style="text-align:right;min-width:120px;">
                <div style="font-weight:800;color:var(--brand-dark);">${formatCurrency(bus.price || 0)}</div>
                <div style="font-size:0.85rem;color:${isAvailable? 'green' : '#a0a0a0'}">${status}</div>
            </div>
            <button class="btn-select-route" style="padding:8px 16px;background:${isAvailable?'var(--brand-dark)':'#ccc'};color:white;border:none;border-radius:6px;cursor:${isAvailable?'pointer':'not-allowed'};font-weight:600;" ${isAvailable?'':'disabled'}>
                Select
            </button>
        </div>
    `;
    
    // Add click handler to select button if available
    if (isAvailable) {
        const btn = div.querySelector('.btn-select-route');
        btn.addEventListener('click', () => selectRoute(routeName, bus));
    }
    
    return div;
}

function selectRoute(routeName, bus) {
    // Store route and bus data in sessionStorage so bookings.html can access it
    const routeText = bus.route || routeName || '';
    const unicodeArrow = String.fromCharCode(8594); // -> visual arrow
    const mojibakeArrow = '\u00e2\u2020\u2019'; // common broken encoding for arrow
    const normalizedRoute = String(routeText).replaceAll(mojibakeArrow, unicodeArrow);
    const routeParts = normalizedRoute.split(/(?:\u2192|->)/).map((s) => s.trim()).filter(Boolean);
    const from = routeParts[0] || 'Campus';
    const to = routeParts[1] || 'District';

    sessionStorage.setItem('selectedRoute', JSON.stringify({
        name: routeName || routeText,
        route: normalizedRoute,
        from,
        to
    }));
    sessionStorage.setItem('selectedBus', JSON.stringify(bus));
    
    // Navigate to bookings page
    window.location.href = 'bookings.html';
}
function renderSection(containerId, items){
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if(!items || items.length === 0){
        container.innerHTML = '<div class="faded">No routes available right now.</div>';
        return;
    }

    // Render each route as a card with buses
    items.forEach(route => {
        const card = document.createElement('div');
        card.className = 'booking-visuals';
        card.style.marginBottom = '18px';

        const header = document.createElement('div');
        header.innerHTML = `<h4 style="margin-bottom:6px">${route.name}</h4><div class="helper-text">${route.description || ''}</div>`;
        card.appendChild(header);

        if(route.buses && route.buses.length){
            route.buses.forEach(bus => card.appendChild(createBusItem(bus, route.name)));
        } else {
            const noB = document.createElement('div');
            noB.className = 'faded';
            noB.style.marginTop = '6px';
            noB.textContent = 'No buses for this route yet.';
            card.appendChild(noB);
        }

        container.appendChild(card);
    });
}

async function fetchAndRender(){
    const endpoint = document.body.dataset.routesEndpoint || API_URL_FALLBACK;
    const lastUpdatedEl = document.getElementById('last-updated');
    const refreshBtn = document.getElementById('refresh-btn');

    try {
        if (refreshBtn) refreshBtn.classList.add('is-loading');
        const res = await fetch(endpoint, {cache: 'no-store'});
        if(!res.ok) throw new Error('Network response not ok');
        const data = await res.json();

        // Expecting schema: { ttfpp: [...], cobes: [...], intercity: [...] }
        renderSection('ttfpp-list', data.ttfpp || []);
        renderSection('cobes-list', data.cobes || []);
        renderSection('intercity-list', data.intercity || []);

        lastUpdatedEl.textContent = new Date().toLocaleString();
    } catch (err){
        // On error, show a helpful message and fallback sample data
        lastUpdatedEl.textContent = 'Error fetching data';

        const sample = [
            { name: 'Sample Route A', description: 'Sample description', buses: [{name:'Bus A1', price:15, availableSeats:6}] }
        ];
        renderSection('ttfpp-list', sample);
        renderSection('cobes-list', sample);
        renderSection('intercity-list', sample);
    } finally {
        if (refreshBtn) refreshBtn.classList.remove('is-loading');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    requireAuth(); // Require user to be logged in
    fetchAndRender();
    document.getElementById('refresh-btn').addEventListener('click', fetchAndRender);
});

