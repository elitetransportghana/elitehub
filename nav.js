document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.querySelector('.nav-toggle');
    const links = document.querySelector('.nav-links');

    if (!toggle || !links) return;

    const closeMenu = () => {
        links.classList.remove('open');
        document.body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
        const icon = toggle.querySelector('i');
        if (icon) {
            icon.classList.remove('fa-xmark');
            icon.classList.add('fa-bars');
        }
    };

    const openMenu = () => {
        links.classList.add('open');
        document.body.classList.add('nav-open');
        toggle.setAttribute('aria-expanded', 'true');
        const icon = toggle.querySelector('i');
        if (icon) {
            icon.classList.remove('fa-bars');
            icon.classList.add('fa-xmark');
        }
    };

    toggle.addEventListener('click', () => {
        if (links.classList.contains('open')) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    links.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));

    document.addEventListener('click', (event) => {
        if (!links.classList.contains('open')) return;
        if (links.contains(event.target) || toggle.contains(event.target)) return;
        closeMenu();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeMenu();
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth > 900) closeMenu();
    });
});
