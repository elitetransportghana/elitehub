// toast.js
// Custom toast notification system

class Toast {
    constructor() {
        this.createContainer();
    }

    createContainer() {
        if (!document.getElementById('toast-container')) {
            const container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                display: flex;
                flex-direction: column;
                gap: 10px;
                pointer-events: none;
            `;
            document.body.appendChild(container);
        }
    }

    show(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        const colors = {
            success: '#10b981',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#3b82f6'
        };
        
        const icons = {
            success: '<i class="fa-solid fa-check-circle"></i>',
            error: '<i class="fa-solid fa-exclamation-circle"></i>',
            warning: '<i class="fa-solid fa-warning"></i>',
            info: '<i class="fa-solid fa-info-circle"></i>'
        };

        toast.style.cssText = `
            background-color: ${colors[type] || colors.info};
            color: white;
            padding: 16px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 500;
            animation: slideIn 0.3s ease-out;
            pointer-events: auto;
            max-width: 400px;
            word-wrap: break-word;
        `;

        toast.innerHTML = `
            <span style="font-size: 1.2rem; flex-shrink: 0;">${icons[type]}</span>
            <span style="flex: 1;">${message}</span>
            <button style="background: rgba(255,255,255,0.2); border: none; color: white; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 1.1rem; flex-shrink: 0;">
                <i class="fa-solid fa-times"></i>
            </button>
        `;

        container.appendChild(toast);

        // Close button handler
        toast.querySelector('button').addEventListener('click', () => {
            toast.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => toast.remove(), 300);
        });

        // Auto remove after duration
        if (duration > 0) {
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.style.animation = 'slideOut 0.3s ease-out';
                    setTimeout(() => toast.remove(), 300);
                }
            }, duration);
        }

        return toast;
    }

    success(message, duration = 3000) {
        return this.show(message, 'success', duration);
    }

    error(message, duration = 3000) {
        return this.show(message, 'error', duration);
    }

    warning(message, duration = 3000) {
        return this.show(message, 'warning', duration);
    }

    info(message, duration = 3000) {
        return this.show(message, 'info', duration);
    }
}

const toast = new Toast();

// Add animations to stylesheet if not present
if (!document.querySelector('style[data-toast-animations]')) {
    const style = document.createElement('style');
    style.setAttribute('data-toast-animations', 'true');
    style.innerHTML = `
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(400px);
                opacity: 0;
            }
        }

        @media (max-width: 640px) {
            #toast-container {
                left: 10px !important;
                right: 10px !important;
            }
            
            .toast {
                max-width: 100% !important;
            }
        }
    `;
    document.head.appendChild(style);
}
