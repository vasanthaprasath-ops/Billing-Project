/*
 * Interaction polish for the Android app (loaded after app.js and m3.js):
 * haptics, screen transitions, add-to-cart feedback, Undo snackbars, skeleton loaders,
 * counting numbers, pull-to-refresh, swipe-down-to-close sheets, a boot screen and an
 * animated checkout tick. Everything respects the phone's "remove animations" setting.
 */
(function () {
    "use strict";

    const Cap = window.Capacitor;
    const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
    const Haptics = native && Cap.registerPlugin ? Cap.registerPlugin("Haptics") : null;
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const $ = s => document.querySelector(s);
    const icon = (n, f) => (window.m3Icon ? window.m3Icon(n, f) : "");

    // ---------------- haptics ----------------
    const buzz = {
        tap() { if (Haptics) Haptics.impact({ style: "LIGHT" }).catch(() => {}); },
        success() { if (Haptics) Haptics.notification({ type: "SUCCESS" }).catch(() => {}); },
        error() { if (Haptics) Haptics.notification({ type: "ERROR" }).catch(() => {}); },
    };
    window.fmHaptics = buzz;

    // ---------------- boot screen (instead of a blank page while the database opens) ----------------
    const boot = document.createElement("div");
    boot.className = "fm-boot";
    boot.innerHTML = `<div class="fm-boot-logo">${icon("storefront", true)}</div>
        <div class="fm-boot-name">FreshMart Billing</div><div class="fm-boot-bar"><span></span></div>`;
    document.body.appendChild(boot);
    const bootDone = () => {
        const shown = !$("#appRoot").classList.contains("hidden") || !$("#loginScreen").classList.contains("hidden");
        if (!shown || !boot.isConnected) return;
        boot.classList.add("out");
        setTimeout(() => boot.remove(), 300);
    };
    const bootObs = new MutationObserver(bootDone);
    bootObs.observe($("#appRoot"), { attributes: true, attributeFilter: ["class"] });
    bootObs.observe($("#loginScreen"), { attributes: true, attributeFilter: ["class"] });

    // ---------------- helpers to hook app.js ----------------
    function around(name, fn) {
        const orig = window[name];
        if (typeof orig !== "function") return;
        window[name] = function () { return fn.call(this, orig, arguments); };
    }

    // ---------------- screen transitions ----------------
    around("switchView", function (orig, args) {
        const same = args[0] === currentView;
        if (same || reduced() || !document.startViewTransition) return orig.apply(this, args);
        let r;
        document.startViewTransition(() => { r = orig.apply(this, args); });
        return r;
    });

    // ---------------- add to cart: pulse + bump + tap ----------------
    around("addToCart", function (orig, args) {
        const before = cart.reduce((n, l) => n + l.qty, 0);
        const r = orig.apply(this, args);
        const after = cart.reduce((n, l) => n + l.qty, 0);
        if (after > before) {
            buzz.tap();
            const card = document.querySelector(`.product-card[data-id="${CSS.escape(args[0])}"]`);
            if (card) { card.classList.remove("fm-pulse"); void card.offsetWidth; card.classList.add("fm-pulse"); }
            const bar = $(".m3-cartbar");
            if (bar) { bar.classList.remove("fm-bump"); void bar.offsetWidth; bar.classList.add("fm-bump"); }
        }
        return r;
    });

    // ---------------- snackbar with an action (Undo) ----------------
    function snackbar(message, actionLabel, onAction) {
        const root = $("#toastRoot");
        const t = document.createElement("div");
        t.className = "toast info fm-snack";
        t.innerHTML = `<span class="t-msg"></span><button type="button" class="fm-snack-act"></button>`;
        t.querySelector(".t-msg").textContent = message;
        t.querySelector(".fm-snack-act").textContent = actionLabel;
        const close = () => { t.style.opacity = "0"; setTimeout(() => t.remove(), 200); };
        t.querySelector(".fm-snack-act").onclick = e => { e.stopPropagation(); close(); onAction(); };
        root.appendChild(t);
        setTimeout(close, 5000);
    }
    around("stepCart", function (orig, args) {
        const [i, act] = args;
        const line = cart[i] ? Object.assign({}, cart[i]) : null;
        const willRemove = line && (act === "rm" || (act === "dec" && line.qty <= 1));
        const r = orig.apply(this, args);
        if (willRemove) {
            buzz.tap();
            snackbar(line.name + " removed", "Undo", () => { cart.splice(Math.min(i, cart.length), 0, line); renderCart(); buzz.tap(); });
        }
        return r;
    });

    // ---------------- toasts: haptic on errors and successes ----------------
    around("toast", function (orig, args) {
        if (args[1] === "error") buzz.error();
        return orig.apply(this, args);
    });

    // ---------------- checkout success: animated tick + success haptic ----------------
    around("showInvoiceSuccess", function (orig, args) {
        const r = orig.apply(this, args);
        buzz.success();
        const ic = $("#modalRoot .success-icon");
        if (ic) ic.innerHTML = `<svg viewBox="0 0 52 52" class="fm-tick"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>`;
        return r;
    });

    // ---------------- skeletons instead of "Loading…" + counting numbers ----------------
    const SKELETON = `<div class="fm-skel"><div class="fm-skel-row"><i></i><i></i></div><div class="fm-skel-row"><i></i><i></i></div>
        <b></b><b></b><b class="short"></b><b></b><b class="short"></b></div>`;
    function polish(root) {
        root.querySelectorAll(".empty-state").forEach(e => {
            if (e.textContent.trim() === "Loading…" && !e.dataset.fmSkel) { e.dataset.fmSkel = "1"; e.innerHTML = SKELETON; e.classList.add("fm-skel-host"); }
        });
        if (reduced()) return;
        root.querySelectorAll("#view-dashboard .stat-value:not([data-fm-count])").forEach(countUp);
    }
    function countUp(el) {
        el.dataset.fmCount = "1";
        const text = el.textContent;
        const m = /(\d[\d,]*)(\.\d+)?/.exec(text);
        if (!m) return;
        const target = parseFloat((m[1] + (m[2] || "")).replace(/,/g, ""));
        if (!(target > 0)) return;
        const decimals = m[2] ? m[2].length - 1 : 0;
        const start = performance.now(), dur = 650;
        const step = now => {
            const p = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            const v = (target * eased).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
            el.textContent = text.slice(0, m.index) + v + text.slice(m.index + m[0].length);
            if (p < 1) requestAnimationFrame(step); else el.textContent = text;
        };
        requestAnimationFrame(step);
    }
    new MutationObserver(() => polish(document.body)).observe(document.body, { childList: true, subtree: true });

    // ---------------- pull to refresh (Home, Invoices, Products, Customers, Day report) ----------------
    const PULL_VIEWS = ["dashboard", "invoices", "products", "customers", "dayreport"];
    const spinner = document.createElement("div");
    spinner.className = "fm-ptr";
    spinner.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>`;
    document.body.appendChild(spinner);
    let pullStart = null, pulled = 0;
    document.addEventListener("touchstart", e => {
        const blocked = document.querySelector("#modalRoot .modal-overlay, .m3-sheet, body.m3-cart-open");
        pullStart = (window.scrollY <= 0 && !blocked && PULL_VIEWS.includes(currentView) && e.touches.length === 1) ? e.touches[0].clientY : null;
        pulled = 0;
    }, { passive: true });
    document.addEventListener("touchmove", e => {
        if (pullStart == null) return;
        pulled = Math.max(0, Math.min(120, (e.touches[0].clientY - pullStart) * 0.5));
        spinner.style.transform = `translate(-50%, ${pulled - 48}px) rotate(${pulled * 3}deg)`;
        spinner.classList.toggle("armed", pulled >= 64);
        spinner.style.opacity = String(Math.min(1, pulled / 64));
    }, { passive: true });
    document.addEventListener("touchend", () => {
        if (pullStart == null) return;
        pullStart = null;
        if (pulled >= 64) {
            buzz.tap();
            spinner.classList.add("spin");
            spinner.style.transform = "translate(-50%, 24px)";
            Promise.resolve(typeof loadItems === "function" ? loadItems() : null).catch(() => {})
                .then(() => refreshCurrentView())
                .finally(() => setTimeout(() => { spinner.classList.remove("spin", "armed"); spinner.style.opacity = "0"; spinner.style.transform = ""; }, 350));
        } else {
            spinner.style.opacity = "0";
            spinner.style.transform = "";
        }
    });

    // ---------------- swipe down to close sheets and dialogs ----------------
    let drag = null;
    document.addEventListener("touchstart", e => {
        const el = e.target.closest(".m3-sheet, body.m3-cart-open .pos .cart, #modalRoot .modal");
        if (!el || e.touches.length !== 1) { drag = null; return; }
        // Grab from the handle / header strip only - lower down, a drag scrolls the sheet's content.
        const r = el.getBoundingClientRect();
        if (e.touches[0].clientY - r.top > 88 || e.target.closest("input, select, textarea, button")) { drag = null; return; }
        drag = { el, y0: e.touches[0].clientY, dy: 0 };
        el.style.transition = "none";
    }, { passive: true });
    document.addEventListener("touchmove", e => {
        if (!drag) return;
        drag.dy = Math.max(0, e.touches[0].clientY - drag.y0);
        drag.el.style.transform = `translateY(${drag.dy}px)`;
    }, { passive: true });
    document.addEventListener("touchend", () => {
        if (!drag) return;
        const { el, dy } = drag;
        drag = null;
        el.style.transition = "";
        el.style.transform = "";
        if (dy < 110) return;
        if (el.classList.contains("m3-sheet") || el.classList.contains("cart")) { if (window.m3Back) window.m3Back(); }
        else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // ---------------- tap the current tab again -> back to top ----------------
    document.addEventListener("click", e => {
        const d = e.target.closest(".m3-dest.active[data-view]");
        if (d) window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
        if (e.target.closest(".m3-dest, .m3-fab, .m3-list-item")) buzz.tap();
    }, true);
})();
