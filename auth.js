// auth.js
// Authentication helper utilities for all pages

const API_BASE = 'https://realeliteweb-app.elitetransportghana.workers.dev/api';

function notify(type, message, duration = 3000) {
    if (window.toast && typeof window.toast[type] === 'function') {
        window.toast[type](message, duration);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](message);
}

// Check if user is logged in
function isUserLoggedIn() {
    return !!localStorage.getItem('authToken');
}

// Get current user
function getCurrentUser() {
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user) : null;
}

// Get auth token
function getAuthToken() {
    return localStorage.getItem('authToken');
}

// Logout
function logout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
}

// Update navbar with user info
function updateNavbar() {
    const user = getCurrentUser();
    const isLoggedIn = isUserLoggedIn();
    
    // Find the nav-links element
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;

    // Remove existing auth buttons (if any)
    const existingAuthBtns = navLinks.querySelectorAll('[data-auth-btn]');
    existingAuthBtns.forEach(btn => btn.remove());

    if (isLoggedIn && user) {
        // Add user profile and logout
        const userProfile = document.createElement('li');
        userProfile.setAttribute('data-auth-btn', 'user-profile');
        userProfile.style.display = 'flex';
        userProfile.style.alignItems = 'center';
        userProfile.style.gap = '10px';
        userProfile.innerHTML = `
            <a href="profile.html" style="font-size:0.9rem;color:var(--text-main);text-decoration:none;cursor:pointer;font-weight:500;hover:color:var(--brand-dark);">${user.name || user.email}</a>
            <button id="logout-btn" style="padding:8px 16px;background:var(--brand-dark);color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Logout</button>
        `;
        navLinks.appendChild(userProfile);

        // Attach logout handler
        document.getElementById('logout-btn').addEventListener('click', logout);
    } else {
        // Add login button
        const loginBtn = document.createElement('li');
        loginBtn.setAttribute('data-auth-btn', 'login');
        const link = document.createElement('a');
        link.href = 'login.html';
        link.className = 'btn-nav';
        link.textContent = 'Sign In';
        loginBtn.appendChild(link);
        navLinks.appendChild(loginBtn);
    }
}

// Require auth (redirect to login if not logged in)
function requireAuth() {
    if (!isUserLoggedIn()) {
        notify('warning', 'Please sign in to continue.');
        window.location.href = 'login.html';
    }
}

// Initialize auth on page load
document.addEventListener('DOMContentLoaded', () => {
    updateNavbar();
});
