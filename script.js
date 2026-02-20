document.addEventListener('DOMContentLoaded', () => {
    const notify = (type, message, duration = 3000) => {
        if (window.toast && typeof window.toast[type] === 'function') {
            window.toast[type](message, duration);
            return;
        }
        console[type === 'error' ? 'error' : 'log'](message);
    };
    
    // 1. Select DOM elements
    const seats = document.querySelectorAll('.seat:not(.occupied)');
    const seatInput = document.getElementById('seat-number');
    const seatDisplay = document.getElementById('selected-seat-display');
    const tripSelect = document.getElementById('trip-select');
    const totalPriceDisplay = document.getElementById('total-price');

    let ticketPrice = 0; // Default price state

    // 2. Handle Trip Selection (Updates Price)
    tripSelect.addEventListener('change', (e) => {
        ticketPrice = +e.target.value; // Convert value string to number
        
        // Reset seat selection if route changes
        resetSelection();
        updatePriceDisplay();
    });

    // 3. Handle Seat Selection
    seats.forEach(seat => {
        seat.addEventListener('click', () => {
            
            // Validation: Must select trip first
            if (tripSelect.value === "0") {
                notify('warning', "Please select a route from the dropdown first.");
                tripSelect.focus();
                return;
            }

            // Exclusive Selection: Deselect all other seats
            seats.forEach(s => s.classList.remove('selected'));

            // Select clicked seat
            seat.classList.add('selected');

            // Update Form Data
            const selectedSeatNum = seat.getAttribute('data-seat');
            seatInput.value = selectedSeatNum;
            seatDisplay.innerText = selectedSeatNum; // Updates the visual text

            // Update Price
            updatePriceDisplay();
        });
    });

    // Helper: Reset selection
    function resetSelection() {
        seats.forEach(s => s.classList.remove('selected'));
        seatInput.value = "";
        seatDisplay.innerText = "None";
    }

    // Helper: Update Price Display
    function updatePriceDisplay() {
        const hasSeatSelected = document.querySelectorAll('.seat.selected').length > 0;
        
        if (hasSeatSelected && ticketPrice > 0) {
            totalPriceDisplay.innerText = `GHS ${ticketPrice.toFixed(2)}`;
        } else {
            totalPriceDisplay.innerText = 'GHS 0.00';
        }
    }

    // 4. Form Submission (Demo Logic)
    const form = document.getElementById('bookingForm');
    form.addEventListener('submit', (e) => {
        e.preventDefault(); // Stop page refresh
        
        if(!seatInput.value) {
            notify('warning', "Please select a seat on the bus diagram.");
            return;
        }

        if(tripSelect.value === "0") {
            notify('warning', "Please select a valid route.");
            return;
        }

        // In a real app, this is where you send data to backend
        const routeName = tripSelect.options[tripSelect.selectedIndex].text;
        notify('success', `Booking request received for ${routeName}, seat ${seatInput.value}, total GHS ${ticketPrice.toFixed(2)}.`);
    });
});
