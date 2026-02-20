// login.js
// Handles Google OAuth authentication and email/password sign in/up

const API_BASE = 'https://realeliteweb-app.elitetransportghana.workers.dev/api'; // Update to your Worker URL
const GOOGLE_CLIENT_ID = '966183405136-720qmqdk4g5o0vc8ifnrp9anvqedfo68.apps.googleusercontent.com'; // Replace with your Client ID

let currentTab = 'sign-in';
let pendingGoogleUser = null; // Store Google user data temporarily

function notify(type, message, duration = 3000) {
    if (window.toast && typeof window.toast[type] === 'function') {
        window.toast[type](message, duration);
        return;
    }
    console[type === 'error' ? 'error' : 'log'](message);
}

// Tab switching
function switchTab(tab) {
    currentTab = tab;
    const signInContent = document.getElementById('sign-in-content');
    const signUpContent = document.getElementById('sign-up-content');
    const tabs = document.querySelectorAll('.tab-btn');

    if (tab === 'sign-in') {
        signInContent.style.display = 'block';
        signUpContent.style.display = 'none';
        tabs[0].style.color = 'var(--brand-dark)';
        tabs[0].style.borderBottom = '3px solid var(--brand-dark)';
        tabs[1].style.color = 'var(--text-muted)';
        tabs[1].style.borderBottom = '2px solid #eee';
    } else {
        signInContent.style.display = 'none';
        signUpContent.style.display = 'block';
        tabs[0].style.color = 'var(--text-muted)';
        tabs[0].style.borderBottom = '2px solid #eee';
        tabs[1].style.color = 'var(--brand-dark)';
        tabs[1].style.borderBottom = '3px solid var(--brand-dark)';
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Google Sign-In for Sign In form
    window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleSignInResponse
    });

    // Render Google Sign-In button for Sign In
    window.google.accounts.id.renderButton(
        document.getElementById('sign-in-google'),
        { 
            theme: 'outline',
            size: 'large',
            width: '100%',
            text: 'signin'
        }
    );

    // Render Google Sign-Up button for Sign Up
    window.google.accounts.id.renderButton(
        document.getElementById('sign-up-google'),
        { 
            theme: 'outline',
            size: 'large',
            width: '100%',
            text: 'signup'
        }
    );

    // Attach form handlers
    document.getElementById('signInForm').addEventListener('submit', handleEmailSignIn);
    document.getElementById('signUpForm').addEventListener('submit', handleEmailSignUp);
});

// Google OAuth Callback
function handleGoogleSignInResponse(response) {
    const token = response.credential;
    
    // Decode JWT (Google ID token) to extract user info
    const parts = token.split('.');
    const payload = JSON.parse(atob(parts[1]));
    
    const userData = {
        googleId: payload.sub,
        email: payload.email,
        firstName: payload.given_name || '',
        lastName: payload.family_name || '',
        picture: payload.picture,
        authMethod: 'google',
        idToken: token
    };

    // Sign in should not ask for contact details again.
    // Sign up collects contacts once for new account creation.
    if (currentTab === 'sign-up') {
        pendingGoogleUser = userData;
        showGoogleContactForm();
        return;
    }

    authenticateWithGoogle({
        ...userData,
        mode: 'signin'
    });
}

// Show modal to collect contact information for Google OAuth users
function showGoogleContactForm() {
    // Create or show modal
    let modal = document.getElementById('google-contact-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'google-contact-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        `;
        
        const form = document.createElement('div');
        form.style.cssText = `
            background: white;
            padding: 40px;
            border-radius: 8px;
            width: 90%;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        `;
        
        form.innerHTML = `
            <h2 style="margin-bottom: 10px; color: var(--brand-dark);">Complete Your Profile</h2>
            <p style="margin-bottom: 20px; color: var(--text-muted); font-size: 14px;">We need a few more details to complete your registration.</p>
            
            <form id="google-contact-form">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500; color: var(--text-dark);">Phone Number *</label>
                    <input type="tel" id="google-phone" required style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; box-sizing: border-box;" placeholder="+233 XX XXX XXXX">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500; color: var(--text-dark);">Next of Kin Name</label>
                    <input type="text" id="google-nok-name" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; box-sizing: border-box;" placeholder="Name">
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 5px; font-weight: 500; color: var(--text-dark);">Next of Kin Phone</label>
                    <input type="tel" id="google-nok-phone" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; box-sizing: border-box;" placeholder="+233 XX XXX XXXX">
                </div>
                
                <button type="submit" style="width: 100%; padding: 12px; background-color: var(--brand-dark); color: white; border: none; border-radius: 4px; font-weight: 500; cursor: pointer; font-size: 14px;">
                    Complete Registration
                </button>
            </form>
        `;
        
        modal.appendChild(form);
        document.body.appendChild(modal);
        
        // Attach event listener to dynamically created form
        document.getElementById('google-contact-form').addEventListener('submit', handleGoogleContactSubmit);
    }
    modal.style.display = 'flex';
}

// Handle Google contact form submission
async function handleGoogleContactSubmit(e) {
    e.preventDefault();
    
    const phone = document.getElementById('google-phone').value;
    const nokName = document.getElementById('google-nok-name').value;
    const nokPhone = document.getElementById('google-nok-phone').value;
    
    if (!phone) {
        notify('warning', 'Phone number is required.');
        return;
    }
    
    // Add contact info to pending Google user
    pendingGoogleUser.phone = phone;
    pendingGoogleUser.nokName = nokName || null;
    pendingGoogleUser.nokPhone = nokPhone || null;
    
    // Close modal
    const modal = document.getElementById('google-contact-modal');
    if (modal) modal.style.display = 'none';
    
    // Complete authentication
    authenticateWithGoogle({
        ...pendingGoogleUser,
        mode: 'signup'
    });
    pendingGoogleUser = null;
}

async function authenticateWithGoogle(userData) {
    try {
        const response = await fetch(`${API_BASE}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                googleId: userData.googleId,
                email: userData.email,
                firstName: userData.firstName,
                lastName: userData.lastName,
                picture: userData.picture,
                phone: userData.phone || null,
                nokName: userData.nokName || null,
                nokPhone: userData.nokPhone || null,
                mode: userData.mode || 'signin'
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Authentication failed');
        }

        const result = await response.json();
        
        // Store auth token and user data
        localStorage.setItem('authToken', result.token);
        localStorage.setItem('user', JSON.stringify(result.user));
        
        // Redirect to routes page
        window.location.href = 'routes.html';
    } catch (err) {
        // Close modal on error
        const modal = document.getElementById('google-contact-modal');
        if (modal) modal.style.display = 'none';
        notify('error', 'Authentication failed: ' + err.message);
    }
}

// Email Sign In
async function handleEmailSignIn(e) {
    e.preventDefault();

    const email = document.getElementById('signin-email').value;
    const password = document.getElementById('signin-password').value;

    if (!email || !password) {
        notify('warning', 'Please fill in all fields.');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/auth/signin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Sign in failed');
        }

        const result = await response.json();
        
        // Store auth token and user data
        localStorage.setItem('authToken', result.token);
        localStorage.setItem('user', JSON.stringify(result.user));
        
        // Redirect to routes page
        window.location.href = 'routes.html';
    } catch (err) {
        notify('error', 'Sign in failed: ' + err.message);
    }
}

// Email Sign Up
async function handleEmailSignUp(e) {
    e.preventDefault();

    const firstName = document.getElementById('signup-first-name').value;
    const lastName = document.getElementById('signup-last-name').value;
    const email = document.getElementById('signup-email').value;
    const phone = document.getElementById('signup-phone').value;
    const password = document.getElementById('signup-password').value;

    if (!firstName || !lastName || !email || !phone || !password) {
        notify('warning', 'Please fill in all fields.');
        return;
    }

    if (password.length < 6) {
        notify('warning', 'Password must be at least 6 characters.');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firstName,
                lastName,
                email,
                phone,
                password
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Sign up failed');
        }

        const result = await response.json();
        
        // Store auth token and user data
        localStorage.setItem('authToken', result.token);
        localStorage.setItem('user', JSON.stringify(result.user));
        
        // Redirect to routes page
        window.location.href = 'routes.html';
    } catch (err) {
        notify('error', 'Sign up failed: ' + err.message);
    }
}

// Check if user is logged in
function getCurrentUser() {
    const token = localStorage.getItem('authToken');
    const user = localStorage.getItem('user');
    
    if (token && user) {
        return JSON.parse(user);
    }
    return null;
}

// Logout
function logout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
}
