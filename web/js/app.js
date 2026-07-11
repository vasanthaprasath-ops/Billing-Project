/* ============================================================
   FreshMart Grocery Billing — front-end logic (vanilla JS)
   Talks to the Java backend over the /api JSON endpoints.
   ============================================================ */

let session = null;    // {username, fullName, role, branchId, branchName, mustChangePassword}
let store = { name: "FreshMart", currency: "Rs." };
let branches = [];     // all branches (used for the switcher + admin screens)
let currentBranchId = null; // ADMIN: selected branch, or null = "All Branches"; others: always their own branch
let items = [];        // catalogue, refreshed from the server
let cart = [];         // [{id,name,unit,price,taxRatePercent,stock,qty}]
let currentView = "dashboard";
let currentAdminTab = "branches";
let invoicesSubTab = "sales"; // "sales" or "returns"
let productsLowStockOnly = false; // true only when Products was opened via a "Low Stock" shortcut

/* ---------------- API client ---------------- */
const api = {
    async get(path) { return handle(await fetch(path)); },
    async send(method, path, body) {
        return handle(await fetch(path, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body != null ? JSON.stringify(body) : undefined
        }));
    },
    post(p, b) { return this.send("POST", p, b); },
    put(p, b) { return this.send("PUT", p, b); },
    del(p) { return this.send("DELETE", p); }
};
async function handle(res) {
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    if (res.status === 401) {
        // Only an already-signed-in session bouncing to a 401 counts as an
        // "expired" surprise worth explaining - a fresh visit with no cookie yet,
        // or a wrong-password attempt on the login form itself, both also land
        // here with session already null, and should just show the server's own
        // message (handled by the generic throw below) instead of this one.
        const wasSignedIn = !!session;
        session = null;
        showLogin();
        if (wasSignedIn) {
            throw new Error("Your session has expired. Please sign in again.");
        }
    }
    if (!res.ok) throw new Error((data && data.error) || ("Request failed (" + res.status + ")"));
    return data;
}

/* ---------------- helpers ---------------- */
function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g,
        c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtNum(v) {
    return Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money(v) { return store.currency + " " + fmtNum(v); }
function fmtQty(q) { q = Number(q || 0); return Number.isInteger(q) ? String(q) : String(q); }

/** Returns a wrapped fn that only fires after `ms` of quiet - swap into keystroke handlers
 *  that rebuild large HTML strings so a fast typist doesn't cause a paint per key. */
/** Maps a payment-mode label to a stable palette slot so the same mode always gets
 *  the same colour across sessions - matters when the shop owner scans the mix at a glance. */
function payColor(mode) {
    const m = String(mode || "").trim().toLowerCase();
    if (m === "cash") return "green";
    if (m === "card") return "blue";
    if (m === "upi") return "violet";
    return "amber";
}

function debounced(fn, ms) {
    let t = null;
    return function () {
        const ctx = this, args = arguments;
        if (t) clearTimeout(t);
        t = setTimeout(() => fn.apply(ctx, args), ms);
    };
}

function buildQuery(params) {
    const parts = [];
    for (const k in params) {
        const v = params[k];
        if (v !== null && v !== undefined && v !== "") {
            parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
        }
    }
    return parts.length ? "?" + parts.join("&") : "";
}
/** null when a non-admin (server infers their branch) or when an admin has "All Branches" selected. */
function adminBranchParam() {
    return session.role === "ADMIN" ? currentBranchId : null;
}

/* ---------------- reporting period (shared by dashboard + invoices) ---------------- */
let reportPeriod = localStorage.getItem("fm_period") || "today";
const PERIODS = [["today", "Today"], ["week", "7 Days"], ["month", "This Month"], ["all", "All Time"]];

function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
/** Local-time inclusive [from,to] for the active period; nulls mean open-ended (all time). */
function periodRange() {
    const now = new Date();
    const today = ymd(now);
    if (reportPeriod === "today") return { from: today, to: today };
    if (reportPeriod === "week") {
        const s = new Date(now); s.setDate(now.getDate() - 6);
        return { from: ymd(s), to: today };
    }
    if (reportPeriod === "month") {
        return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    }
    return { from: null, to: null };
}
function periodLabel() {
    const p = PERIODS.find(x => x[0] === reportPeriod);
    return p ? p[1] : "All Time";
}
function periodControl() {
    return `<div class="period-seg">${PERIODS.map(([k, l]) =>
        `<button class="period-btn ${reportPeriod === k ? "active" : ""}" data-period="${k}">${esc(l)}</button>`).join("")}</div>`;
}
function wirePeriodControl(root, onChange) {
    root.querySelectorAll("[data-period]").forEach(b => b.onclick = () => {
        if (b.dataset.period === reportPeriod) return;
        reportPeriod = b.dataset.period;
        localStorage.setItem("fm_period", reportPeriod);
        onChange();
    });
}

function toast(msg, type = "info") {
    const root = document.getElementById("toastRoot");
    const t = document.createElement("div");
    t.className = "toast " + type;
    t.title = "Dismiss";
    const ico = type === "success" ? "✓" : type === "error" ? "⚠" : "ℹ";
    t.innerHTML = `<span class="t-ico">${ico}</span><span class="t-msg"></span>`;
    t.querySelector(".t-msg").textContent = msg;
    root.appendChild(t);
    // Fade-and-remove, shared by the auto-timeout and a click-to-dismiss - so an
    // error a cashier needs to read stays until dismissed if they tap it, and
    // several stacked toasts can be cleared without waiting them out one by one.
    let done = false;
    const dismiss = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        t.style.transition = "all .3s";
        t.style.opacity = "0";
        t.style.transform = "translateX(20px)";
        setTimeout(() => t.remove(), 300);
    };
    t.addEventListener("click", dismiss);
    // Errors linger longer than success/info - they usually need action, not just a glance.
    const timer = setTimeout(dismiss, type === "error" ? 6000 : 3200);
}

let modalLastFocused = null;

function openModal(html, opts) {
    opts = opts || {};
    modalLastFocused = document.activeElement;
    const root = document.getElementById("modalRoot");
    root.innerHTML = `<div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    const overlay = root.querySelector(".modal-overlay");
    // Buttons default to type="submit"; inside these modals there is no <form>
    // owner, but making that explicit prevents accidental form-submit if a
    // caller later wraps the modal in one, and shuts up strict accessibility
    // linters. Also give the close (×) button an accessible name.
    overlay.querySelectorAll("button:not([type])").forEach(b => { b.type = "button"; });
    overlay.querySelectorAll(".modal-close").forEach(b => {
        if (!b.hasAttribute("aria-label")) b.setAttribute("aria-label", "Close dialog");
    });
    const heading = overlay.querySelector(".modal-head h3");
    if (heading) {
        if (!heading.id) heading.id = "modalTitle-" + Math.random().toString(36).slice(2, 9);
        overlay.setAttribute("aria-labelledby", heading.id);
    }
    if (opts.dismissible !== false) {
        overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
        document.addEventListener("keydown", escClose);
    }
    document.addEventListener("keydown", modalTrapFocus);
    document.addEventListener("keydown", modalEnterSubmit);
    // Hide the rest of the app from assistive tech while the dialog is open - it's a
    // sibling of #modalRoot, not an ancestor, so this can't trap focus inside itself.
    document.getElementById("appRoot").setAttribute("aria-hidden", "true");
    document.getElementById("loginScreen").setAttribute("aria-hidden", "true");
    // Initial focus: prefer the first focusable field inside the body (so data-entry
    // modals let you start typing immediately), else the first footer button (so
    // confirm dialogs default to Cancel, since it's first in the DOM), else the dialog itself.
    const target = modalFocusable(overlay.querySelector(".modal-body"))[0]
        || modalFocusable(overlay.querySelector(".modal-foot"))[0]
        || overlay;
    target.focus();
}

function modalFocusable(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
}

function modalTrapFocus(e) {
    if (e.key !== "Tab") return;
    const overlay = document.querySelector("#modalRoot .modal-overlay");
    if (!overlay) return;
    const focusable = modalFocusable(overlay);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    }
}

function escClose(e) { if (e.key === "Escape") closeModal(); }

/**
 * Enter, while focus is in a single-line field of the open modal, fires the
 * modal's primary action - the same thing clicking the green (or red, for
 * destructive dialogs) footer button would. This makes every data-entry dialog
 * submittable from the keyboard without reaching for the mouse, which is what
 * anyone typing a form expects. Textareas, selects and buttons keep their
 * native Enter behaviour; a disabled primary button (e.g. a refund with nothing
 * entered yet) is left alone.
 */
function modalEnterSubmit(e) {
    if (e.key !== "Enter" || e.isComposing) return;
    const overlay = document.querySelector("#modalRoot .modal-overlay");
    if (!overlay) return;
    const el = document.activeElement;
    if (!el || !overlay.contains(el) || el.tagName !== "INPUT") return;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "checkbox", "radio", "file"].includes(type)) return;
    const primary = overlay.querySelector(".modal-foot .btn-primary, .modal-foot .btn-danger");
    if (!primary || primary.disabled) return;
    e.preventDefault();
    primary.click();
}

function closeModal() {
    document.getElementById("modalRoot").innerHTML = "";
    document.removeEventListener("keydown", escClose);
    document.removeEventListener("keydown", modalTrapFocus);
    document.removeEventListener("keydown", modalEnterSubmit);
    document.getElementById("appRoot").removeAttribute("aria-hidden");
    document.getElementById("loginScreen").removeAttribute("aria-hidden");
    if (modalLastFocused && document.contains(modalLastFocused)) {
        modalLastFocused.focus();
    }
    modalLastFocused = null;
}

/**
 * Disables btn and swaps its label to busyLabel for the duration of fn(), so a
 * slow request or an impatient double-click can't fire the same submit twice.
 * Always restores the button afterwards - harmless even if the caller is
 * about to remove it anyway (e.g. by closing the modal on success).
 */
async function withBusy(btn, busyLabel, fn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
        await fn();
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

/**
 * Generic "are you sure?" dialog for destructive / hard-to-undo actions.
 * While onConfirm's promise is pending, both buttons are disabled and the
 * confirm button shows busyLabel, so an impatient second click (or a slow
 * network) can't fire the same request twice. onConfirm is responsible for
 * closing the modal and toasting its own result on success; on failure it
 * should throw so the dialog re-enables for a retry instead of looking stuck.
 */
function confirmAction({ title, message, confirmLabel = "Confirm", busyLabel = "Working…", danger = true, onConfirm }) {
    openModal(`
        <div class="modal" style="max-width:380px">
            <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" id="cxClose">×</button></div>
            <div class="modal-body"><p class="mini-sub" style="margin:0">${message}</p></div>
            <div class="modal-foot">
                <button class="btn" id="cxCancel">Cancel</button>
                <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="cxOk">${esc(confirmLabel)}</button>
            </div>
        </div>`);
    document.getElementById("cxClose").onclick = closeModal;
    document.getElementById("cxCancel").onclick = closeModal;
    document.getElementById("cxOk").onclick = async () => {
        const okBtn = document.getElementById("cxOk");
        const cancelBtn = document.getElementById("cxCancel");
        const original = okBtn.textContent;
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        okBtn.textContent = busyLabel;
        try {
            await onConfirm();
        } catch (e) {
            okBtn.disabled = false;
            cancelBtn.disabled = false;
            okBtn.textContent = original;
        }
    };
}

/* ============================================================
   AUTH / LOGIN
   ============================================================ */
function showLogin() {
    document.getElementById("appRoot").classList.add("hidden");
    document.getElementById("loginScreen").classList.remove("hidden");
}
function showApp() {
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appRoot").classList.remove("hidden");
}

async function doLogin(e) {
    e.preventDefault();
    const btn = document.getElementById("loginSubmit");
    const errEl = document.getElementById("loginError");
    errEl.classList.add("hidden");
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!username || !password) {
        errEl.textContent = "Enter your username and password.";
        errEl.classList.remove("hidden");
        return;
    }
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
        session = await api.post("/api/auth/login", { username, password });
        document.getElementById("loginPassword").value = "";
        showApp();
        await bootApp();
        if (session.mustChangePassword) {
            openChangePasswordModal(true);
        }
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove("hidden");
    } finally {
        btn.disabled = false;
        btn.textContent = "Sign In";
    }
}

async function doLogout() {
    try { await api.post("/api/auth/logout", {}); } catch (e) { /* ignore */ }
    session = null;
    cart = [];
    items = [];
    document.getElementById("loginPassword").value = "";
    showLogin();
}

function confirmLogout() {
    const n = cart.length;
    confirmAction({
        title: "Log out?",
        message: n > 0
            ? `You have <b>${n}</b> item${n === 1 ? "" : "s"} in the current bill that ${n === 1 ? "hasn't" : "haven't"} been checked out. Logging out will discard ${n === 1 ? "it" : "them"}.`
            : "You'll need to sign in again to continue.",
        confirmLabel: "Log Out",
        busyLabel: "Logging out…",
        onConfirm: async () => { await doLogout(); closeModal(); }
    });
}

function openChangePasswordModal(forced) {
    openModal(`
        <div class="modal" style="max-width:380px">
            <div class="modal-head"><h3>${forced ? "Set Your Password" : "Change Password"}</h3>
                ${forced ? "" : `<button class="modal-close" id="mClose">×</button>`}</div>
            <div class="modal-body">
                ${forced
                    ? `<p class="mini-sub" style="margin:0 0 14px">This is a new account — choose a password only you know.</p>`
                    : `<div class="field"><label for="cpCurrent">Current Password</label><input class="input" id="cpCurrent" type="password"></div>`}
                <div class="field"><label for="cpNew">New Password</label>
                    <input class="input" id="cpNew" type="password" placeholder="At least 6 characters"></div>
                <div class="field"><label for="cpConfirm">Confirm New Password</label><input class="input" id="cpConfirm" type="password"></div>
            </div>
            <div class="modal-foot">
                ${forced ? "" : `<button class="btn" id="mCancel">Cancel</button>`}
                <button class="btn btn-primary" id="mSave">Save</button>
            </div>
        </div>`, { dismissible: !forced });
    if (!forced) {
        document.getElementById("mClose").onclick = closeModal;
        document.getElementById("mCancel").onclick = closeModal;
    }
    document.getElementById("mSave").onclick = () => withBusy(document.getElementById("mSave"), "Saving…", async () => {
        const newPassword = document.getElementById("cpNew").value;
        const confirmValue = document.getElementById("cpConfirm").value;
        if (newPassword.length < 6) { toast("New password must be at least 6 characters", "error"); return; }
        if (newPassword !== confirmValue) { toast("Passwords do not match", "error"); return; }
        const body = { newPassword };
        if (!forced) body.currentPassword = document.getElementById("cpCurrent").value;
        try {
            session = await api.post("/api/auth/change-password", body);
            closeModal();
            renderUserBox();
            toast("Password updated", "success");
        } catch (e) { toast(e.message, "error"); }
    });
}

/* ---------------- role / branch scoping ---------------- */
function applyRoleVisibility() {
    document.getElementById("navProducts").classList.toggle("hidden", session.role === "CASHIER");
    document.getElementById("navAdmin").classList.toggle("hidden", session.role !== "ADMIN");
}

function renderUserBox() {
    document.getElementById("userBox").innerHTML = `
        <div class="u-name">${esc(session.fullName || session.username)}</div>
        <div class="u-branch mini-sub">${esc(session.branchName || "All Branches")}</div>
        <span class="u-role">${esc(session.role)}</span>`;
}

function setupBranchSwitcher() {
    const sel = document.getElementById("branchSwitcher");
    if (session.role !== "ADMIN") {
        sel.classList.add("hidden");
        currentBranchId = session.branchId;
        return;
    }
    sel.classList.remove("hidden");
    const saved = localStorage.getItem("fm_branch") || "all";
    sel.innerHTML = `<option value="all">All Branches</option>` +
        branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
    sel.value = branches.some(b => b.id === saved) ? saved : "all";
    currentBranchId = sel.value === "all" ? null : sel.value;
    sel.onchange = () => {
        currentBranchId = sel.value === "all" ? null : sel.value;
        localStorage.setItem("fm_branch", sel.value);
        renderStoreFooter();
        // Re-render only AFTER the new branch's items have loaded. Firing loadItems()
        // without awaiting it let refreshCurrentView() paint the Products/Billing screen
        // from the previous branch's stale `items` array (the Dashboard masked this by
        // re-fetching its own figures from the server), causing the product count and
        // list to lag a branch behind the switcher.
        loadItems().catch(() => {}).finally(refreshCurrentView);
    };
}

function branchPickerEmptyState(message) {
    return `<div class="empty-state">
        <div class="big">🏬</div>${esc(message)}
        <div><select class="input" id="branchPickerSelect">
            <option value="">Choose a branch…</option>
            ${branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}
        </select></div>
    </div>`;
}
function wireBranchPicker(onPicked) {
    const sel = document.getElementById("branchPickerSelect");
    if (!sel) return;
    sel.onchange = () => {
        if (!sel.value) return;
        currentBranchId = sel.value;
        document.getElementById("branchSwitcher").value = sel.value;
        localStorage.setItem("fm_branch", sel.value);
        onPicked();
    };
}

/* ---------------- navigation ---------------- */
const VIEW_META = {
    dashboard: ["Dashboard", "Overview of your store"],
    billing: ["New Bill", "Ring up a sale and print an invoice"],
    products: ["Products", "Manage your catalogue and stock"],
    invoices: ["Invoices", "Browse and reprint past bills"],
    dayreport: ["Day Report", "Day-end reconciliation for your till"],
    admin: ["Admin", "Branches, users, audit log and backups"],
    settings: ["Settings", "Personalise your dashboard and preferences"]
};

function switchView(name, opts) {
    if (name === "products" && session.role === "CASHIER") {
        toast("You don't have access to Products", "error");
        return;
    }
    if (name === "admin" && session.role !== "ADMIN") {
        toast("You don't have access to Admin", "error");
        return;
    }
    // Reset by default so the filter can never leak into a later, unrelated visit to Products -
    // only the dashboard's "Low Stock" shortcuts pass lowStockOnly: true.
    if (name === "products") productsLowStockOnly = !!(opts && opts.lowStockOnly);
    currentView = name;
    document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    document.getElementById("view-" + name).classList.remove("hidden");
    document.getElementById("viewTitle").textContent = VIEW_META[name][0];
    document.getElementById("viewSub").textContent = VIEW_META[name][1];

    if (name === "dashboard") loadDashboard();
    else if (name === "billing") renderBilling();
    else if (name === "products") loadProducts();
    else if (name === "invoices") loadInvoices();
    else if (name === "dayreport") renderZReportTab(document.getElementById("view-dayreport"));
    else if (name === "admin") renderAdminTab(currentAdminTab);
    else if (name === "settings") renderSettings();
}

/* ============================================================
   USER SETTINGS (per-user, persisted in localStorage)
   ============================================================
   Layout is a { visible: Set<string>, order: string[] } shape - `order` is the
   authoritative sequence and `visible` filters it. Keyed by username so two people
   using the same machine don't overwrite each other's dashboard. */

// Every configurable dashboard bucket, in the DEFAULT order. Anything not in `order`
// falls back to this list at the end (so a future new bucket appears automatically).
const DASHBOARD_BUCKETS = [
    { key: "stats",         label: "Summary stat tiles",  hint: "The four coloured cards at the top" },
    { key: "category",      label: "Revenue by Category" },
    { key: "profit",        label: "Profit by Category",  hint: "Needs cost prices on items" },
    { key: "topItems",      label: "Top Items" },
    { key: "payment",       label: "Payment Mix" },
    { key: "lowStock",      label: "Low Stock Alerts" },
    { key: "recentInvoices",label: "Recent Invoices" },
    { key: "branch",        label: "Sales by Branch",     hint: "Only shown when viewing All Branches" }
];
const DEFAULT_BUCKET_ORDER = DASHBOARD_BUCKETS.map(b => b.key);

function settingsKey() { return "fm_settings_" + (session && session.username || "guest"); }

function loadUserSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(settingsKey()) || "{}"); } catch (e) { s = {}; }
    const visibleArr = Array.isArray(s.visible) ? s.visible : DEFAULT_BUCKET_ORDER.slice();
    const orderArr = Array.isArray(s.order) && s.order.length ? s.order.slice() : DEFAULT_BUCKET_ORDER.slice();
    // Repair drift: drop keys we no longer know about, and append any new default keys.
    const known = new Set(DEFAULT_BUCKET_ORDER);
    const order = orderArr.filter(k => known.has(k));
    DEFAULT_BUCKET_ORDER.forEach(k => { if (!order.includes(k)) order.push(k); });
    return {
        visible: new Set(visibleArr.filter(k => known.has(k))),
        order,
        theme: s.theme || "auto",                        // "auto" | "light" | "dark"
        defaultPeriod: s.defaultPeriod || null,          // "today" | "week" | "month" | "all"
        defaultView: s.defaultView || "dashboard"
    };
}

function saveUserSettings(patch) {
    const cur = loadUserSettings();
    const next = {
        visible: Array.from(patch.visible || cur.visible),
        order: patch.order || cur.order,
        theme: patch.theme || cur.theme,
        defaultPeriod: patch.defaultPeriod === undefined ? cur.defaultPeriod : patch.defaultPeriod,
        defaultView: patch.defaultView || cur.defaultView
    };
    localStorage.setItem(settingsKey(), JSON.stringify(next));
}

/** Apply the saved theme by stamping data-theme on <html>; the CSS's dark-mode
 *  rules already fire on that attribute in addition to prefers-color-scheme. */
function applyThemePreference() {
    const t = loadUserSettings().theme;
    const root = document.documentElement;
    if (t === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
}

async function loadItems() {
    if (session.role === "ADMIN" && !currentBranchId) {
        items = [];
        return;
    }
    items = await api.get("/api/items" + buildQuery({ branchId: adminBranchParam() }));
}

/* ============================================================
   DASHBOARD
   ============================================================ */
async function loadDashboard() {
    const view = document.getElementById("view-dashboard");
    view.innerHTML = `<div class="empty-state">Loading…</div>`;
    let d;
    const pr = periodRange();
    try {
        d = await api.get("/api/dashboard" + buildQuery({
            branchId: session.role === "ADMIN" ? (currentBranchId || "all") : null,
            from: pr.from, to: pr.to
        }));
    } catch (e) { view.innerHTML = `<div class="empty-state">Could not load dashboard.</div>`; return; }

    const canManage = session.role !== "CASHIER";
    const netValue = d.refundCount > 0 ? d.netSales : d.totalSales;
    const netLabel = d.refundCount > 0 ? "Net Sales" : "Total Sales";
    // Sales-delta chip: up/down arrow + percentage vs the equal-length window before this one.
    // Server sends previousNetSales=0 when no comparable window applies (all-time or first day).
    let deltaChip = "";
    if (d.previousNetSales > 0) {
        const pct = ((netValue - d.previousNetSales) / d.previousNetSales) * 100;
        const cls = pct >= 0 ? "up" : "down";
        const arrow = pct >= 0 ? "▲" : "▼";
        deltaChip = `<span class="delta-chip ${cls}" title="vs previous ${esc(periodLabel().toLowerCase())}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
    }
    // Profit tile: shows margin when the owner has entered any item cost. Until then it
    // nudges them to set costs (a single click into Products → Edit).
    const hasCostData = Number(d.profitCoverage || 0) > 0;
    const marginLabel = hasCostData
        ? `${d.grossMarginPercent.toFixed(1)}% margin`
        : "Set costs to see profit";
    const cards = [
        { ico: "💰", cls: "green", value: money(netValue), label: netLabel, nav: "invoices",
          hint: d.refundCount > 0 ? `Gross ${money(d.totalSales)} − Refunds ${money(d.refundTotal)}` : "View invoices →",
          extra: deltaChip },
        { ico: "📈", cls: hasCostData ? "green" : "muted", value: hasCostData ? money(d.profit) : "—",
          label: "Profit", nav: hasCostData ? "invoices" : "products",
          hint: hasCostData ? marginLabel : "Add cost prices →" },
        { ico: "🧾", cls: "blue", value: d.invoiceCount, label: "Invoices", nav: "invoices",
          hint: d.invoiceCount > 0 ? `Avg. bill ${money(d.averageSale)}` : "No sales in period" },
        { ico: "⚠️", cls: d.lowStockCount > 0 ? "amber" : "muted", value: d.lowStockCount,
          label: "Low Stock", nav: "products", filter: "lowstock",
          hint: d.lowStockCount > 0 ? "Restock now →" : "All well stocked" }
    ];

    // Branch bar chart: real horizontal bars with % share, replacing the plain amount list.
    // Normalised to one local array so every reference below is guarded the same way,
    // instead of mixing guarded (|| []) and unguarded d.branchRevenue accesses.
    const branchRevenue = d.branchRevenue || [];
    const maxBranch = Math.max(1, ...branchRevenue.map(b => b.amount));
    const totalBranchRevenue = branchRevenue.reduce((s, b) => s + b.amount, 0);
    const branchCard = d.allBranches ? `
        <div class="card">
            <div class="card-head"><div class="card-title">Sales by Branch</div>
                <span class="mini-sub">${branchRevenue.length} branch${branchRevenue.length === 1 ? "" : "es"}</span></div>
            <div class="card-body">
                ${branchRevenue.length ? branchRevenue.map(b => {
                    const share = totalBranchRevenue > 0 ? (b.amount / totalBranchRevenue * 100) : 0;
                    return `<div class="bar-row">
                        <div class="bar-label">
                            <span class="cat">${esc(b.branchName)} <span class="mini-sub">· ${b.invoiceCount} bill(s)</span></span>
                            <span class="amt">${money(b.amount)} <span class="mini-sub">· ${share.toFixed(0)}%</span></span>
                        </div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, b.amount / maxBranch * 100)}%"></div></div>
                    </div>`;
                }).join("") : `<div class="mini-sub">No branches yet.</div>`}
            </div>
        </div>` : "";

    // Profit by category — same shape as revenue chart but coloured differently.
    const catProfit = d.categoryProfit || [];
    const maxProfit = Math.max(1, ...catProfit.map(c => Math.abs(c.amount)));
    const profitCard = `
        <div class="card">
            <div class="card-head"><div class="card-title">Profit by Category</div>
                <span class="mini-sub">${hasCostData ? "current cost basis" : "no cost data yet"}</span></div>
            <div class="card-body">
                ${catProfit.length ? catProfit.map(c => `
                    <div class="bar-row">
                        <div class="bar-label"><span class="cat">${esc(c.category)}</span>
                            <span class="amt" style="color:${c.amount < 0 ? "var(--red)" : "var(--green-dark)"}">${c.amount < 0 ? "− " : ""}${money(Math.abs(c.amount))}</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, Math.abs(c.amount) / maxProfit * 100)}%"></div></div>
                    </div>`).join("") : `<div class="empty-state-inline">${hasCostData ? "No sales in this period." : "Add cost prices to your products from Products → Edit to see profit."}</div>`}
            </div>
        </div>`;

    // Category chart
    const maxCat = Math.max(1, ...d.categoryRevenue.map(c => c.amount));
    const categoryCard = `
        <div class="card">
            <div class="card-head"><div class="card-title">Revenue by Category</div>
                <span class="mini-sub">${d.categoryRevenue.length} categor${d.categoryRevenue.length === 1 ? "y" : "ies"}</span></div>
            <div class="card-body">
                ${d.categoryRevenue.length ? d.categoryRevenue.map(c => `
                    <div class="bar-row">
                        <div class="bar-label"><span class="cat">${esc(c.category)}</span><span class="amt">${money(c.amount)}</span></div>
                        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, c.amount / maxCat * 100)}%"></div></div>
                    </div>`).join("") : `<div class="empty-state">No sales yet — create a bill to see analytics.</div>`}
            </div>
        </div>`;

    // Payment mix: a single segmented bar - visually shows the mode split at a glance
    // (cashier/owner-relevant during the day, and reconciles against the till at close).
    const paymentMix = d.paymentMix || [];
    const totalPay = paymentMix.reduce((s, p) => s + p.amount, 0);
    const paymentCard = `
        <div class="card">
            <div class="card-head"><div class="card-title">Payment Mix</div>
                <span class="mini-sub">${totalPay > 0 ? money(totalPay) + " collected" : "No sales in period"}</span></div>
            <div class="card-body">
                ${paymentMix.length ? `
                    <div class="pay-mix-bar">
                        ${paymentMix.map((p, i) => {
                            const share = totalPay > 0 ? (p.amount / totalPay * 100) : 0;
                            return `<span class="pay-seg pay-seg-${payColor(p.mode)}" style="width:${share}%" title="${esc(p.mode)}: ${money(p.amount)}"></span>`;
                        }).join("")}
                    </div>
                    <div class="pay-legend">
                        ${paymentMix.map(p => {
                            const share = totalPay > 0 ? (p.amount / totalPay * 100) : 0;
                            return `<div class="pay-legend-row">
                                <span class="pay-dot pay-seg-${payColor(p.mode)}"></span>
                                <span class="pay-name">${esc(p.mode)}</span>
                                <span class="pay-count mini-sub">${p.count} bill(s)</span>
                                <span class="pay-amt">${money(p.amount)} <span class="mini-sub">· ${share.toFixed(0)}%</span></span>
                            </div>`;
                        }).join("")}
                    </div>` : `<div class="mini-sub">No sales in this period.</div>`}
            </div>
        </div>`;

    // Top items chart
    const topItems = d.topItems || [];
    const maxTop = Math.max(1, ...topItems.map(t => t.amount));
    const topItemsCard = `
        <div class="card">
            <div class="card-head"><div class="card-title">Top Items</div>
                <span class="mini-sub">by revenue</span></div>
            <div class="card-body">
                ${topItems.length ? topItems.map(t => `
                    <div class="bar-row">
                        <div class="bar-label">
                            <span class="cat">${esc(t.name)} <span class="mini-sub">· ${fmtQty(t.quantity)} ${esc(t.unit || "")}</span></span>
                            <span class="amt">${money(t.amount)}</span>
                        </div>
                        <div class="bar-track"><div class="bar-fill amber" style="width:${Math.max(3, t.amount / maxTop * 100)}%"></div></div>
                    </div>`).join("") : `<div class="mini-sub">No sales in this period.</div>`}
            </div>
        </div>`;

    const lowStockCard = `
        <div class="card">
            <div class="card-head"><div class="card-title">Low Stock Alerts</div>
                <button class="link-action" data-nav="products" data-filter="lowstock">Manage →</button></div>
            <div class="card-body">
                <div class="mini-list">
                    ${d.lowStock.length ? d.lowStock.slice(0, 6).map(s => `
                        <div class="mini-row clickable" data-restock="${esc(s.id)}" data-branch="${esc(s.branchId)}" title="Click to restock">
                            <div><div class="mini-main">${esc(s.name)}</div><div class="mini-sub">${esc(s.id)} · tap to restock</div></div>
                            <span class="pill ${s.stock <= s.reorderLevel / 2 ? "danger" : "warn"}">${fmtQty(s.stock)} ${esc(s.unit)} left</span>
                        </div>`).join("") : `<div class="empty-state-inline"><span class="big">👍</span>All items are well stocked.</div>`}
                </div>
            </div>
        </div>`;

    const recentInvoicesCard = `
        <div class="card">
            <div class="card-head"><div class="card-title">Recent Invoices</div>
                <button class="link-action" data-nav="invoices">View all →</button></div>
            <div class="card-body">
                <div class="mini-list">
                    ${d.recentInvoices.length ? d.recentInvoices.map(r => `
                        <div class="mini-row clickable" data-pdf="/api/invoices/${encodeURIComponent(r.invoiceNo)}/pdf" title="Open invoice PDF">
                            <div><div class="mini-main">${esc(r.invoiceNo)}</div><div class="mini-sub">${esc(r.customerName)} • ${esc(r.dateTime)}</div></div>
                            <span class="money">${money(r.grandTotal)}</span>
                        </div>`).join("") : `<div class="mini-sub">No invoices yet.</div>`}
                </div>
            </div>
        </div>`;

    // Layout is now user-configurable via Settings - a saved `order` array + `visible` set
    // decides what buckets appear and in what sequence. The Sales-by-Branch bucket still
    // only shows for all-branches; anything else the user has turned off is skipped
    // regardless of scope. We still distribute the visible cards across three columns for
    // wide viewports (below 1024px CSS collapses them to one column).
    const settings = loadUserSettings();
    const statsHtml = `
        <div class="stat-grid">
            ${cards.map(c => `
                <div class="stat-card clickable" data-nav="${c.nav}" data-filter="${c.filter || ""}">
                    <div class="stat-top">
                        <span class="stat-ico ${c.cls}">${c.ico}</span>
                        <span class="stat-label">${c.label}</span>
                    </div>
                    <div class="stat-value-row">
                        <div class="stat-value">${c.value}</div>
                        ${c.extra || ""}
                    </div>
                    <div class="stat-hint">${c.hint}</div>
                </div>`).join("")}
        </div>`;
    const bucketHtml = {
        stats: statsHtml,
        category: categoryCard,
        profit: profitCard,
        topItems: topItemsCard,
        payment: paymentCard,
        lowStock: lowStockCard,
        recentInvoices: recentInvoicesCard,
        branch: d.allBranches ? branchCard : ""
    };
    // Stats spans all three columns; every other visible bucket goes into the grid, dealt
    // out round-robin so col heights stay roughly balanced regardless of what's turned on.
    const gridBuckets = settings.order.filter(k =>
        k !== "stats" && settings.visible.has(k) && bucketHtml[k]);
    const cols = [[], [], []];
    gridBuckets.forEach((k, i) => cols[i % 3].push(bucketHtml[k]));
    const showStats = settings.visible.has("stats");

    view.innerHTML = `
        <div class="dash-header">
            <div class="dash-context">
                <span class="dash-scope">${esc(d.branchName)}</span>
                <span class="dash-scope-dot">·</span>
                <span class="dash-scope">${esc(periodLabel())}</span>
            </div>
            <div class="dash-actions">
                ${periodControl()}
                <button class="btn btn-primary btn-sm" id="qaNewBill">🧾 Start New Bill</button>
                ${canManage ? `<button class="btn btn-sm" id="qaAddProduct">＋ Add Product</button>` : ""}
                <button class="btn btn-ghost btn-sm" id="qaCustomize" title="Choose which cards appear on your dashboard">🎛️ Customize</button>
            </div>
        </div>

        ${showStats ? statsHtml : ""}

        <div class="dash-grid dash-grid-3">
            <div class="stack-16">${cols[0].join("")}</div>
            <div class="stack-16">${cols[1].join("")}</div>
            <div class="stack-16">${cols[2].join("")}</div>
        </div>
        ${gridBuckets.length === 0 && !showStats
            ? `<div class="empty-state"><div class="big">🎛️</div>Your dashboard is empty.<br>
                <button class="btn btn-primary" style="margin-top:14px" id="qaCustomize2">Choose what to show</button></div>`
            : ""}`;

    // wire up the interactions
    wirePeriodControl(view, loadDashboard);
    view.querySelectorAll("[data-nav]").forEach(e =>
        e.addEventListener("click", () => switchView(e.dataset.nav, { lowStockOnly: e.dataset.filter === "lowstock" })));
    view.querySelectorAll("[data-restock]").forEach(e =>
        e.addEventListener("click", () => openRestock(e.dataset.restock, e.dataset.branch)));
    view.querySelectorAll("[data-pdf]").forEach(e =>
        e.addEventListener("click", () => window.open(e.dataset.pdf, "_blank")));
    document.getElementById("qaNewBill").addEventListener("click", () => switchView("billing"));
    const qaAdd = document.getElementById("qaAddProduct");
    if (qaAdd) qaAdd.addEventListener("click", () => {
        if (session.role === "ADMIN" && !currentBranchId) { toast("Pick a branch first", "error"); return; }
        openProductModal(null);
    });
    const qaCustomize = document.getElementById("qaCustomize");
    if (qaCustomize) qaCustomize.addEventListener("click", () => switchView("settings"));
    const qaCustomize2 = document.getElementById("qaCustomize2");
    if (qaCustomize2) qaCustomize2.addEventListener("click", () => switchView("settings"));
}

/* ============================================================
   SETTINGS VIEW
   ============================================================ */
function renderSettings() {
    const view = document.getElementById("view-settings");
    const s = loadUserSettings();
    const bucketRow = (b, idx) => `
        <li class="bucket-row" draggable="true" data-key="${esc(b.key)}" data-idx="${idx}">
            <span class="drag-grip" aria-hidden="true">⋮⋮</span>
            <label class="check-inline" style="flex:1">
                <input type="checkbox" data-bucket="${esc(b.key)}" ${s.visible.has(b.key) ? "checked" : ""}>
                <span>
                    <div class="bucket-label">${esc(b.label)}</div>
                    ${b.hint ? `<div class="mini-sub">${esc(b.hint)}</div>` : ""}
                </span>
            </label>
        </li>`;
    // Show buckets in the user's saved order so they can see (and rearrange) their layout.
    const ordered = s.order.map(k => DASHBOARD_BUCKETS.find(b => b.key === k)).filter(Boolean);
    view.innerHTML = `
        <div class="card settings-card">
            <div class="card-head"><div class="card-title">Dashboard Layout</div>
                <button class="btn btn-sm" id="resetDash">Reset to default</button></div>
            <div class="card-body">
                <p class="mini-sub" style="margin:0 0 10px">Turn cards on or off, and drag ⋮⋮ to reorder. Saved to this browser for <b>${esc(session.fullName || session.username)}</b>.</p>
                <ul class="bucket-list" id="bucketList">
                    ${ordered.map(bucketRow).join("")}
                </ul>
            </div>
        </div>

        <div class="card settings-card" style="margin-top:16px">
            <div class="card-head"><div class="card-title">Appearance & Defaults</div></div>
            <div class="card-body">
                <div class="field"><label>Theme</label>
                    <div class="period-seg" id="themeSeg">
                        ${["auto","light","dark"].map(t => `
                            <button class="period-btn ${s.theme === t ? "active" : ""}" data-theme="${t}">
                                ${t === "auto" ? "Match System" : t[0].toUpperCase() + t.slice(1)}
                            </button>`).join("")}
                    </div></div>
                <div class="field" style="max-width:280px"><label for="setPeriod">Default reporting period</label>
                    <select class="input" id="setPeriod">
                        <option value="">Remember last used</option>
                        <option value="today" ${s.defaultPeriod === "today" ? "selected" : ""}>Today</option>
                        <option value="week" ${s.defaultPeriod === "week" ? "selected" : ""}>7 Days</option>
                        <option value="month" ${s.defaultPeriod === "month" ? "selected" : ""}>This Month</option>
                        <option value="all" ${s.defaultPeriod === "all" ? "selected" : ""}>All Time</option>
                    </select></div>
                <div class="field" style="max-width:280px"><label for="setLanding">Default landing view</label>
                    <select class="input" id="setLanding">
                        ${defaultViewOptions(s.defaultView)}
                    </select></div>
            </div>
        </div>`;

    wireBucketList();
    document.getElementById("resetDash").onclick = () => {
        saveUserSettings({ visible: new Set(DEFAULT_BUCKET_ORDER), order: DEFAULT_BUCKET_ORDER.slice() });
        toast("Dashboard reset to default", "success");
        renderSettings();
    };
    document.querySelectorAll("#themeSeg [data-theme]").forEach(b => b.onclick = () => {
        saveUserSettings({ theme: b.dataset.theme });
        applyThemePreference();
        renderSettings();
    });
    document.getElementById("setPeriod").onchange = e => {
        saveUserSettings({ defaultPeriod: e.target.value || null });
        toast("Default period saved", "success");
    };
    document.getElementById("setLanding").onchange = e => {
        saveUserSettings({ defaultView: e.target.value });
        toast("Default landing view saved", "success");
    };
}

function defaultViewOptions(current) {
    const allowed = ["dashboard", "billing", "invoices", "dayreport"];
    if (session.role !== "CASHIER") allowed.splice(2, 0, "products");
    return allowed.map(v => `<option value="${v}" ${current === v ? "selected" : ""}>${esc(VIEW_META[v][0])}</option>`).join("");
}

function wireBucketList() {
    const list = document.getElementById("bucketList");
    // toggle
    list.querySelectorAll("input[data-bucket]").forEach(cb => cb.onchange = () => {
        const s = loadUserSettings();
        if (cb.checked) s.visible.add(cb.dataset.bucket); else s.visible.delete(cb.dataset.bucket);
        saveUserSettings({ visible: s.visible });
    });
    // drag to reorder
    let dragging = null;
    list.querySelectorAll(".bucket-row").forEach(row => {
        row.addEventListener("dragstart", e => {
            dragging = row;
            row.classList.add("dragging");
            // firefox needs any data set to allow the drag
            try { e.dataTransfer.setData("text/plain", row.dataset.key); } catch (_) {}
        });
        row.addEventListener("dragend", () => {
            if (dragging) dragging.classList.remove("dragging");
            dragging = null;
            const newOrder = [...list.querySelectorAll(".bucket-row")].map(r => r.dataset.key);
            saveUserSettings({ order: newOrder });
        });
        row.addEventListener("dragover", e => {
            e.preventDefault();
            if (!dragging || dragging === row) return;
            const rect = row.getBoundingClientRect();
            const before = (e.clientY - rect.top) < rect.height / 2;
            list.insertBefore(dragging, before ? row : row.nextSibling);
        });
    });
}

function openRestock(id, branchId) {
    if (session.role === "CASHIER") { toast("You don't have access to manage products", "error"); return; }
    if (session.role === "ADMIN" && branchId && branchId !== currentBranchId) {
        currentBranchId = branchId;
        const sel = document.getElementById("branchSwitcher");
        if (sel) sel.value = branchId;
        localStorage.setItem("fm_branch", branchId);
    }
    // The restock flow used to open the full Edit Product modal - which meant any stock
    // number typed while cashiers were selling would clobber the live count on save
    // (the "lost update" bug). Now it opens a dedicated Adjust-Stock dialog: the manager
    // enters how many were received (a delta), the server adds it atomically, and no
    // other product field is touched.
    loadItems().then(() => {
        const it = items.find(x => x.id === id);
        if (it) openAdjustStockModal(it);
        else toast("Item not found", "error");
    }).catch(() => toast("Could not load item", "error"));
}

/** Add or remove stock explicitly, without touching any other field on the product. */
function openAdjustStockModal(item) {
    openModal(`
        <div class="modal" style="max-width:440px">
            <div class="modal-head"><h3>Adjust Stock — ${esc(item.name)}</h3>
                <button class="modal-close" id="mClose">×</button></div>
            <div class="modal-body">
                <p class="mini-sub" style="margin:0 0 12px">
                    Current stock: <b>${fmtQty(item.stock)} ${esc(item.unit)}</b>
                    &nbsp;·&nbsp; Reorder at ${fmtQty(item.reorderLevel)}
                </p>
                <div class="tender-chips" style="margin:0 0 12px">
                    <button type="button" class="chip" data-mode="add">➕ Add stock (receive)</button>
                    <button type="button" class="chip" data-mode="remove">➖ Remove (damage/waste)</button>
                    <button type="button" class="chip" data-mode="set">= Set exact number</button>
                </div>
                <div class="field"><label for="adjQty" id="adjQtyLabel">Quantity to add (${esc(item.unit)})</label>
                    <input class="input" id="adjQty" type="number" min="0" step="1" value="" autofocus></div>
                <div class="field"><label for="adjReason">Reason (optional)</label>
                    <input class="input" id="adjReason" placeholder="e.g. Delivery from supplier, damaged pack, stock-take correction"></div>
                <div id="adjPreview" class="mini-sub" style="margin-top:8px"></div>
            </div>
            <div class="modal-foot">
                <button class="btn" id="mCancel">Cancel</button>
                <button class="btn btn-primary" id="mSave">Save</button>
            </div>
        </div>`);
    let mode = "add"; // add | remove | set
    const qty = () => Math.max(0, parseFloat(document.getElementById("adjQty").value) || 0);
    const updatePreview = () => {
        const q = qty();
        const preview = document.getElementById("adjPreview");
        let after = item.stock;
        if (mode === "add") after = item.stock + q;
        else if (mode === "remove") after = item.stock - q;
        else if (mode === "set") after = q;
        if (after < 0) {
            preview.innerHTML = `<span style="color:var(--red)">That would take stock below zero.</span>`;
        } else {
            preview.textContent = `New stock: ${fmtQty(after)} ${item.unit}`;
        }
    };
    const setMode = (m) => {
        mode = m;
        document.querySelectorAll("#modalRoot .chip[data-mode]").forEach(b =>
            b.classList.toggle("active", b.dataset.mode === m));
        const label = document.getElementById("adjQtyLabel");
        label.textContent = m === "add" ? `Quantity to add (${item.unit})`
                          : m === "remove" ? `Quantity to remove (${item.unit})`
                          : `New stock (${item.unit})`;
        updatePreview();
        document.getElementById("adjQty").focus();
    };
    setMode("add");
    document.querySelectorAll("#modalRoot .chip[data-mode]").forEach(b =>
        b.addEventListener("click", () => setMode(b.dataset.mode)));
    document.getElementById("adjQty").addEventListener("input", updatePreview);
    document.getElementById("mClose").onclick = closeModal;
    document.getElementById("mCancel").onclick = closeModal;
    document.getElementById("mSave").onclick = () => withBusy(document.getElementById("mSave"), "Saving…", async () => {
        const q = qty();
        if (q <= 0) { toast("Enter a positive quantity", "error"); return; }
        const body = {
            branchId: currentBranchId,
            reason: document.getElementById("adjReason").value.trim()
        };
        if (mode === "add") body.delta = q;
        else if (mode === "remove") body.delta = -q;
        else body.newStock = q;
        try {
            await api.post("/api/items/" + encodeURIComponent(item.id) + "/adjust-stock", body);
            closeModal();
            toast("Stock updated", "success");
            await loadItems();
            refreshCurrentView();
        } catch (e) { toast(e.message, "error"); }
    });
}

function refreshCurrentView() {
    if (currentView === "dashboard") loadDashboard();
    else if (currentView === "billing") renderBilling();
    else if (currentView === "products") {
        const s = document.getElementById("prodSearch");
        if (s) renderProducts(s.value); else loadProducts();
    } else if (currentView === "invoices") loadInvoices();
    else if (currentView === "admin") renderAdminTab(currentAdminTab);
}

/* ============================================================
   BILLING / POS
   ============================================================ */
function renderBilling() {
    const view = document.getElementById("view-billing");
    if (session.role === "ADMIN" && !currentBranchId) {
        view.innerHTML = branchPickerEmptyState("Pick a branch to start billing.");
        wireBranchPicker(() => loadItems().then(renderBilling));
        return;
    }

    view.innerHTML = `
        <div class="pos">
            <div class="card pos-products">
                <div class="card-head">
                    <div class="card-title">Products</div>
                    <input class="input search" id="posSearch" placeholder="Search products…" style="max-width:260px">
                </div>
                <div class="card-body">
                    <div class="barcode-bar">
                        <span class="b-ico">📷</span>
                        <input id="barcodeInput" placeholder="Scan barcode or type item ID, then press Enter" autocomplete="off">
                    </div>
                    <div class="product-grid" id="productGrid"></div>
                </div>
            </div>

            <div class="card cart">
                <div class="card-head">
                    <div class="card-title">🧺 Current Bill</div>
                    <button class="btn btn-ghost btn-sm" id="clearCartBtn">Clear</button>
                </div>
                <div class="card-body">
                    <div class="cart-lines" id="cartLines"></div>
                    <div id="cartForm">
                        <div class="field"><label for="custName">Customer Name</label>
                            <input class="input" id="custName" placeholder="Walk-in Customer"></div>
                        <div class="field-row">
                            <div class="field"><label for="custPhone">Phone</label><input class="input" id="custPhone" placeholder="Optional"></div>
                            <div class="field"><label for="payMode">Payment</label>
                                <select class="input" id="payMode"><option>Cash</option><option>Card</option><option>UPI</option></select></div>
                        </div>
                        <div class="field"><label for="posState">Place of Supply <span class="mini-sub">— buyer's state (leave blank for local sale)</span></label>
                            <input class="input" id="posState" maxlength="4" style="text-transform:uppercase" placeholder="e.g. TN, KA (for IGST)"></div>
                        <div class="field"><label for="discount">Discount (${esc(store.currency)})</label>
                            <input class="input" id="discount" type="number" min="0" step="0.01" value="0"></div>
                        <div class="field" id="cashPaidField"><label for="cashPaid">Cash Tendered (${esc(store.currency)})</label>
                            <input class="input" id="cashPaid" type="number" min="0" step="0.01" placeholder="Amount handed over by customer">
                            <div class="tender-chips" id="tenderChips">
                                <button type="button" class="chip" data-tender="exact">Exact</button>
                                <button type="button" class="chip" data-tender="100">+100</button>
                                <button type="button" class="chip" data-tender="200">+200</button>
                                <button type="button" class="chip" data-tender="500">+500</button>
                                <button type="button" class="chip" data-tender="2000">+2000</button>
                                <button type="button" class="chip chip-clear" data-tender="clear">Clear</button>
                            </div></div>
                    </div>
                    <div class="totals" id="cartTotals"></div>
                    <button class="btn btn-primary btn-block btn-lg" id="checkoutBtn" style="margin-top:14px">Checkout &amp; Print Invoice</button>
                </div>
            </div>
        </div>`;

    // Debounce the search-driven grid rebuild: at 10k items the string-concat + DOM parse
    // per keystroke shows up as a visible stutter, and none of the intermediate keystrokes
    // are worth a full paint anyway.
    document.getElementById("posSearch").addEventListener("input", debounced(e => renderProductGrid(e.target.value), 120));
    document.getElementById("clearCartBtn").addEventListener("click", confirmClearCart);
    document.getElementById("discount").addEventListener("input", renderTotals);
    document.getElementById("cashPaid").addEventListener("input", renderTotals);
    document.getElementById("payMode").addEventListener("change", renderTotals);
    document.getElementById("checkoutBtn").addEventListener("click", doCheckout);

    // Quick cash-tender chips: "Exact" fills the grand total (zero change), each
    // note chip adds that denomination to what's already tendered (so two ₹500s
    // handed over is two taps), and "Clear" resets. Faster and less error-prone
    // than typing the amount while a customer waits at the counter.
    const cashInput = document.getElementById("cashPaid");
    document.querySelectorAll("#tenderChips .chip").forEach(chip =>
        chip.addEventListener("click", () => {
            const v = chip.dataset.tender;
            if (v === "clear") cashInput.value = "";
            else if (v === "exact") cashInput.value = String(cartGrandTotal());
            else cashInput.value = String((parseFloat(cashInput.value) || 0) + Number(v));
            renderTotals();
            cashInput.focus();
        }));

    const barcodeInput = document.getElementById("barcodeInput");
    barcodeInput.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); handleBarcodeScan(); }
    });
    barcodeInput.focus();

    renderProductGrid("");
    renderCart();
}

async function handleBarcodeScan() {
    const input = document.getElementById("barcodeInput");
    const code = input.value.trim();
    if (!code) return;
    try {
        const hits = await api.get("/api/items" + buildQuery({ barcode: code, branchId: adminBranchParam() }));
        if (hits.length) {
            addToCart(hits[0].id);
            toast(hits[0].name + " added", "success");
        } else {
            toast("No product matches " + code, "error");
        }
    } catch (e) {
        toast(e.message, "error");
    }
    input.value = "";
    input.focus();
}

function renderProductGrid(filter) {
    const q = (filter || "").toLowerCase();
    const list = items.filter(it => !q
        || it.name.toLowerCase().includes(q)
        || it.category.toLowerCase().includes(q)
        || it.id.toLowerCase().includes(q)
        || (it.barcode || "").toLowerCase().includes(q));
    const grid = document.getElementById("productGrid");
    if (!list.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="big">🔍</div>No products found</div>`;
        return;
    }
    grid.innerHTML = list.map(it => {
        const out = it.stock <= 0;
        const low = it.stock > 0 && it.stock <= it.reorderLevel;
        return `<div class="product-card ${out ? "out" : ""}" data-id="${esc(it.id)}">
            ${out ? "" : `<button class="pc-add" data-id="${esc(it.id)}" type="button" title="Add ${esc(it.name)} to bill" aria-label="Add ${esc(it.name)} to bill">+</button>`}
            <div class="pc-cat">${esc(it.category)}</div>
            <div class="pc-name">${esc(it.name)}</div>
            <div class="pc-foot">
                <span class="pc-price">${money(it.price)}</span>
                <span class="pc-stock ${low ? "low" : ""}">${out ? "Out of stock" : fmtQty(it.stock) + " " + esc(it.unit)}</span>
            </div>
        </div>`;
    }).join("");

    grid.querySelectorAll(".product-card").forEach(c =>
        c.addEventListener("click", () => { if (!c.classList.contains("out")) addToCart(c.dataset.id); }));
    grid.querySelectorAll(".pc-add").forEach(b =>
        b.addEventListener("click", e => { e.stopPropagation(); addToCart(b.dataset.id); }));
}

function addToCart(id) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    const line = cart.find(l => l.id === id);
    const have = line ? line.qty : 0;
    if (have + 1 > it.stock) { toast("Only " + fmtQty(it.stock) + " in stock for " + it.name, "error"); return; }
    if (line) line.qty += 1;
    else cart.push({ id: it.id, name: it.name, unit: it.unit, price: it.price, taxRatePercent: it.taxRatePercent, stock: it.stock, qty: 1 });
    renderCart();
}

function confirmClearCart() {
    if (!cart.length) return;
    const n = cart.length;
    confirmAction({
        title: "Clear cart?",
        message: `Remove all <b>${n}</b> item${n === 1 ? "" : "s"} from the current bill? This cannot be undone.`,
        confirmLabel: "Clear Cart",
        busyLabel: "Clearing…",
        onConfirm: async () => { cart = []; renderCart(); closeModal(); }
    });
}

function stepCart(i, act) {
    const l = cart[i];
    if (!l) return;
    if (act === "rm") { cart.splice(i, 1); renderCart(); return; }
    setQty(i, act === "inc" ? l.qty + 1 : l.qty - 1);
}

function setQty(i, q) {
    const l = cart[i];
    if (!l) return;
    q = Number(q);
    if (!q || q <= 0) { cart.splice(i, 1); renderCart(); return; }
    if (q > l.stock) { toast("Only " + fmtQty(l.stock) + " in stock for " + l.name, "error"); q = l.stock; }
    l.qty = q;
    renderCart();
}

function renderCart() {
    const linesEl = document.getElementById("cartLines");
    if (!linesEl) return;
    if (!cart.length) {
        linesEl.innerHTML = `<div class="cart-empty"><div class="big">🧺</div>Your cart is empty.<br>Click products to add them.</div>`;
    } else {
        linesEl.innerHTML = cart.map((l, i) => `
            <div class="cart-line">
                <div class="cl-info">
                    <div class="cl-name">${esc(l.name)}</div>
                    <div class="cl-price">${money(l.price)} × ${fmtQty(l.qty)} ${esc(l.unit)}</div>
                </div>
                <div class="stepper">
                    <button type="button" data-act="dec" data-i="${i}" aria-label="Decrease quantity">−</button>
                    <input data-i="${i}" value="${fmtQty(l.qty)}" inputmode="decimal" aria-label="${esc(l.name)} quantity">
                    <button type="button" data-act="inc" data-i="${i}" aria-label="Increase quantity">+</button>
                </div>
                <div class="cl-amt">${money(l.price * l.qty)}</div>
                <button class="cl-remove" data-act="rm" data-i="${i}" type="button" title="Remove ${esc(l.name)}" aria-label="Remove ${esc(l.name)}">×</button>
            </div>`).join("");
        linesEl.querySelectorAll("button[data-act]").forEach(b =>
            b.addEventListener("click", () => stepCart(+b.dataset.i, b.dataset.act)));
        linesEl.querySelectorAll("input[data-i]").forEach(inp =>
            inp.addEventListener("change", () => setQty(+inp.dataset.i, parseFloat(inp.value))));
    }
    renderTotals();
    const btn = document.getElementById("checkoutBtn");
    if (btn) btn.disabled = cart.length === 0;
}

function currentDiscount() {
    const el = document.getElementById("discount");
    return Math.max(0, parseFloat(el && el.value) || 0);
}
function currentCashPaid() {
    const el = document.getElementById("cashPaid");
    return Math.max(0, parseFloat(el && el.value) || 0);
}
/** Grand total of the current cart (sub − discount + GST), rounded to the rupee -
 *  the single source of truth for the checkout guard and the "Exact" tender chip. */
function cartGrandTotal() {
    let sub = 0, tax = 0;
    cart.forEach(l => { const amt = l.price * l.qty; sub += amt; tax += amt * l.taxRatePercent / 100; });
    return Math.round(Math.max(0, sub - currentDiscount() + tax));
}

function renderTotals() {
    const el = document.getElementById("cartTotals");
    if (!el) return;
    let sub = 0, tax = 0;
    cart.forEach(l => { const amt = l.price * l.qty; sub += amt; tax += amt * l.taxRatePercent / 100; });
    const discount = currentDiscount();
    // Net payable, then rounded to the nearest rupee (< 50p down, >= 50p up).
    const net = Math.max(0, Math.round((sub - discount + tax) * 100) / 100);
    const grand = Math.round(net);
    const roundOff = Math.round((grand - net) * 100) / 100;
    const roundRow = Math.abs(roundOff) > 0.001
        ? `<div class="total-row"><span>Round Off</span><span>${roundOff >= 0 ? "+ " : "− "}${money(Math.abs(roundOff))}</span></div>`
        : "";
    // Change-due row is only meaningful for cash sales - card / UPI is charged for the
    // exact amount so the tendered field is hidden entirely for those modes.
    const payMode = (document.getElementById("payMode") || {}).value || "Cash";
    const isCash = payMode === "Cash";
    const cashField = document.getElementById("cashPaidField");
    if (cashField) cashField.classList.toggle("hidden", !isCash);
    const cashPaid = currentCashPaid();
    let changeRow = "";
    if (isCash && cashPaid > 0) {
        const change = Math.round((cashPaid - grand) * 100) / 100;
        const cls = change < 0 ? "short" : "change";
        changeRow = `<div class="total-row ${cls}"><span>${change < 0 ? "Short by" : "Change Due"}</span><span>${money(Math.abs(change))}</span></div>`;
    }
    el.innerHTML = `
        <div class="total-row"><span>Sub Total</span><span>${money(sub)}</span></div>
        <div class="total-row"><span>GST</span><span>${money(tax)}</span></div>
        <div class="total-row"><span>Discount</span><span>− ${money(discount)}</span></div>
        ${roundRow}
        <div class="total-row grand"><span>Grand Total</span><span>${money(grand)}</span></div>
        ${changeRow}`;
}

async function doCheckout() {
    if (!cart.length) { toast("Cart is empty", "error"); return; }
    // Guard against ringing up a cash sale that's short of the grand total - once
    // committed the receipt would show 'change: -₹X' and reconcile wrong at day-end.
    const payMode = document.getElementById("payMode").value;
    const cashPaid = currentCashPaid();
    if (payMode === "Cash" && cashPaid > 0 && cashPaid < cartGrandTotal()) {
        toast("Cash tendered is less than the grand total", "error"); return;
    }
    const btn = document.getElementById("checkoutBtn");
    btn.disabled = true;
    btn.textContent = "Processing…";
    const body = {
        branchId: adminBranchParam(),
        customerName: document.getElementById("custName").value,
        customerPhone: document.getElementById("custPhone").value,
        paymentMode: payMode,
        discount: currentDiscount(),
        amountPaid: payMode === "Cash" ? cashPaid : 0,
        placeOfSupplyStateCode: (document.getElementById("posState").value || "").trim().toUpperCase(),
        lines: cart.map(l => ({ itemId: l.id, quantity: l.qty }))
    };
    try {
        const inv = await api.post("/api/checkout", body);
        cart = [];
        await loadItems();
        renderBilling();
        showInvoiceSuccess(inv);
    } catch (e) {
        toast(e.message, "error");
        btn.disabled = false;
        btn.textContent = "Checkout & Print Invoice";
    }
}

function showInvoiceSuccess(inv) {
    const changeLine = Number(inv.changeDue) > 0
        ? `<div class="change-banner">Return change: <b>${money(inv.changeDue)}</b> (received ${money(inv.amountPaid)})</div>`
        : "";
    openModal(`
        <div class="modal" style="max-width:400px">
            <div class="modal-body" style="text-align:center">
                <div class="success-icon">✓</div>
                <h3 style="margin:0 0 4px">Invoice Generated</h3>
                <div class="mini-sub">${esc(inv.invoiceNo)} • ${esc(inv.dateTime)}</div>
                <div style="font-size:30px;font-weight:800;margin:16px 0 4px;color:var(--green-dark)">${money(inv.grandTotal)}</div>
                <div class="mini-sub">${inv.itemCount} item(s) • ${esc(inv.paymentMode)}</div>
                ${changeLine}
            </div>
            <div class="modal-foot" style="justify-content:center;flex-wrap:wrap">
                <button class="btn" id="newBillBtn">New Bill</button>
                <button class="btn btn-primary" id="openPdfBtn">📄 A4 Invoice</button>
                <button class="btn btn-primary" id="openThermalBtn">🧾 Thermal Receipt</button>
            </div>
        </div>`);
    document.getElementById("newBillBtn").onclick = closeModal;
    document.getElementById("openPdfBtn").onclick = () => window.open(inv.pdfUrl, "_blank");
    document.getElementById("openThermalBtn").onclick = () => window.open(inv.thermalPdfUrl, "_blank");
    // also try to open the A4 copy automatically
    window.open(inv.pdfUrl, "_blank");
}

/* ============================================================
   PRODUCTS
   ============================================================ */
async function loadProducts() {
    if (session.role === "ADMIN" && !currentBranchId) {
        document.getElementById("view-products").innerHTML = branchPickerEmptyState("Pick a branch to manage its products.");
        wireBranchPicker(() => loadProducts());
        return;
    }
    try { await loadItems(); } catch (e) { toast("Could not load products", "error"); }
    renderProducts("");
}

function renderProducts(filter) {
    const q = (filter || "").toLowerCase();
    let list = items.filter(it => !q
        || it.name.toLowerCase().includes(q)
        || it.category.toLowerCase().includes(q)
        || it.id.toLowerCase().includes(q)
        || (it.barcode || "").toLowerCase().includes(q));
    if (productsLowStockOnly) list = list.filter(it => it.stock <= it.reorderLevel);
    const canEdit = session.role !== "CASHIER";
    const colCount = canEdit ? 9 : 8;

    // Group by category (aisle), categories A-Z, items A-Z within each - easier to
    // scan a big catalogue than one flat list, and mirrors how a store is laid out.
    const byCategory = new Map();
    list.forEach(it => {
        const cat = it.category || "General";
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(it);
    });
    const categories = Array.from(byCategory.keys()).sort((a, b) => a.localeCompare(b));
    categories.forEach(cat => byCategory.get(cat).sort((a, b) => a.name.localeCompare(b.name)));

    const view = document.getElementById("view-products");
    view.innerHTML = `
        <div class="toolbar">
            <input class="input search" id="prodSearch" placeholder="Search products or barcode…" value="${esc(filter || "")}">
            <label class="check-inline" title="Show only items at or below their reorder level">
                <input type="checkbox" id="lowStockToggle" ${productsLowStockOnly ? "checked" : ""}> Show low stock(s)</label>
            <div class="spacer"></div>
            <span class="mini-sub">${list.length} product(s) in ${categories.length} categor${categories.length === 1 ? "y" : "ies"}</span>
            ${canEdit ? `<button class="btn btn-primary" id="addProdBtn">＋ Add Product</button>` : ""}
        </div>
        <div class="card"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>ID</th><th>Barcode</th><th>Name</th><th>Unit</th>
                <th class="num">Price</th><th class="num">GST %</th><th class="num">Stock</th><th class="num">Reorder At</th>${canEdit ? "<th></th>" : ""}</tr></thead>
            <tbody>${list.length ? categories.map(cat => `
                <tr class="tbl-group-row"><td colspan="${colCount}">${esc(cat)}
                    <span class="tbl-group-count">${byCategory.get(cat).length}</span></td></tr>
                ${byCategory.get(cat).map(it => `
                <tr>
                    <td>${esc(it.id)}</td>
                    <td>${esc(it.barcode || "—")}</td>
                    <td><b>${esc(it.name)}</b></td>
                    <td>${esc(it.unit)}</td>
                    <td class="num">${money(it.price)}</td>
                    <td class="num">${fmtQty(it.taxRatePercent)}%</td>
                    <td class="num">${fmtQty(it.stock)}</td>
                    <td class="num">${fmtQty(it.reorderLevel)}</td>
                    ${canEdit ? `<td class="num">
                        <button class="btn btn-sm" data-adjust="${esc(it.id)}" title="Add or remove stock">📦 Adjust</button>
                        <button class="btn btn-sm" data-edit="${esc(it.id)}">Edit</button>
                        <button class="btn btn-sm btn-danger" data-del="${esc(it.id)}">Delete</button>
                    </td>` : ""}
                </tr>`).join("")}`).join("")
                : `<tr><td colspan="${colCount}"><div class="empty-state"><div class="big">📦</div>${
                    productsLowStockOnly ? "No low-stock items right now. 👍" : "No products found."}</div></td></tr>`}
            </tbody>
        </table></div></div>`;

    const search = document.getElementById("prodSearch");
    search.addEventListener("input", debounced(e => renderProducts(e.target.value), 120));
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
    document.getElementById("lowStockToggle").onchange = e => {
        productsLowStockOnly = e.target.checked;
        renderProducts(search.value);
    };
    if (canEdit) {
        document.getElementById("addProdBtn").onclick = () => openProductModal(null);
        view.querySelectorAll("button[data-edit]").forEach(b =>
            b.onclick = () => openProductModal(items.find(x => x.id === b.dataset.edit)));
        view.querySelectorAll("button[data-adjust]").forEach(b =>
            b.onclick = () => openAdjustStockModal(items.find(x => x.id === b.dataset.adjust)));
        view.querySelectorAll("button[data-del]").forEach(b =>
            b.onclick = () => confirmDeleteProduct(b.dataset.del));
    }
}

function openProductModal(item) {
    const editing = !!item;
    const units = ["pc", "kg", "ltr", "pkt", "dozen", "g"];
    const taxes = [0, 5, 12, 18, 28];
    openModal(`
        <div class="modal">
            <div class="modal-head"><h3>${editing ? "Edit" : "Add"} Product</h3>
                <button class="modal-close" id="mClose">×</button></div>
            <div class="modal-body">
                <div class="field"><label for="fId">Item ID</label>
                    <input class="input" id="fId" ${editing ? "disabled" : ""} value="${editing ? esc(item.id) : ""}" placeholder="Auto-generated if left blank"></div>
                <div class="field"><label for="fName">Name *</label>
                    <input class="input" id="fName" value="${editing ? esc(item.name) : ""}" placeholder="e.g. Basmati Rice 1kg"></div>
                <div class="field-row">
                    <div class="field"><label for="fCat">Category</label>
                        <input class="input" id="fCat" value="${editing ? esc(item.category) : "General"}"></div>
                    <div class="field"><label for="fUnit">Unit</label>
                        <select class="input" id="fUnit">${units.map(u => `<option ${editing && item.unit === u ? "selected" : ""}>${u}</option>`).join("")}</select></div>
                </div>
                <div class="field-row">
                    <div class="field"><label for="fPrice">Selling Price (${esc(store.currency)})</label>
                        <input class="input" id="fPrice" type="number" min="0" step="0.01" value="${editing ? item.price : "0"}"></div>
                    <div class="field"><label for="fCost">Cost Price (${esc(store.currency)})
                        <span class="mini-sub">— what you paid</span></label>
                        <input class="input" id="fCost" type="number" min="0" step="0.01" value="${editing ? (item.costPrice || 0) : "0"}"></div>
                </div>
                <div class="field-row">
                    <div class="field"><label for="fTax">GST %</label>
                        <select class="input" id="fTax">${taxes.map(t => `<option ${editing && item.taxRatePercent === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
                    <div class="field"></div>
                </div>
                <div class="field-row">
                    ${editing ? `<div class="field">
                        <label>Current Stock</label>
                        <div class="input" style="background:var(--bg);color:var(--muted);cursor:default">
                            ${fmtQty(item.stock)} ${esc(item.unit)}
                            <span class="mini-sub" style="margin-left:8px">Use “Adjust Stock” to change</span>
                        </div></div>`
                    : `<div class="field"><label for="fStock">Initial Stock</label>
                        <input class="input" id="fStock" type="number" min="0" step="1" value="0"></div>`}
                    <div class="field"><label for="fReorder">Reorder Alert At</label>
                        <input class="input" id="fReorder" type="number" min="0" step="1" value="${editing ? fmtQty(item.reorderLevel) : "10"}"></div>
                </div>
                <div class="field"><label for="fBarcode">Barcode <span class="mini-sub">(scan with a USB scanner, or type it)</span></label>
                    <input class="input" id="fBarcode" value="${editing ? esc(item.barcode || "") : ""}" placeholder="Optional"></div>
            </div>
            <div class="modal-foot">
                <button class="btn" id="mCancel">Cancel</button>
                <button class="btn btn-primary" id="mSave">${editing ? "Save Changes" : "Add Product"}</button>
            </div>
        </div>`);
    document.getElementById("mClose").onclick = closeModal;
    document.getElementById("mCancel").onclick = closeModal;
    document.getElementById("mSave").onclick = () => withBusy(document.getElementById("mSave"),
        editing ? "Saving…" : "Adding…", () => saveProduct(editing, editing ? item.id : null));
    document.getElementById("fName").focus();
}

async function saveProduct(editing, id) {
    // Note: on edit, we deliberately don't send a stock value - stock only changes through
    // the Adjust Stock action, and the server ignores stock on PUT /items/{id} anyway.
    const dto = {
        id: editing ? id : document.getElementById("fId").value.trim(),
        branchId: currentBranchId,
        name: document.getElementById("fName").value.trim(),
        category: document.getElementById("fCat").value.trim(),
        unit: document.getElementById("fUnit").value,
        price: Math.max(0, parseFloat(document.getElementById("fPrice").value) || 0),
        costPrice: Math.max(0, parseFloat(document.getElementById("fCost").value) || 0),
        taxRatePercent: Math.max(0, parseFloat(document.getElementById("fTax").value) || 0),
        stock: editing ? undefined : Math.max(0, parseFloat(document.getElementById("fStock").value) || 0),
        reorderLevel: Math.max(0, parseFloat(document.getElementById("fReorder").value) || 0),
        barcode: document.getElementById("fBarcode").value.trim()
    };
    if (!dto.name) { toast("Product name is required", "error"); return; }
    try {
        if (editing) await api.put("/api/items/" + encodeURIComponent(id), dto);
        else await api.post("/api/items", dto);
        closeModal();
        toast("Product saved", "success");
        await loadItems();
        refreshCurrentView();
    } catch (e) { toast(e.message, "error"); }
}

function confirmDeleteProduct(id) {
    const it = items.find(x => x.id === id);
    if (!it) return;
    confirmAction({
        title: "Delete product?",
        message: `Delete <b>${esc(it.name)}</b> (${esc(it.id)})? This cannot be undone.`,
        confirmLabel: "Delete",
        busyLabel: "Deleting…",
        onConfirm: async () => {
            await api.del("/api/items/" + encodeURIComponent(id) + buildQuery({ branchId: adminBranchParam() }));
            closeModal();
            toast("Product deleted", "success");
            await loadItems();
            refreshCurrentView();
        }
    });
}

/* ============================================================
   INVOICES
   ============================================================ */
async function loadInvoices() {
    const view = document.getElementById("view-invoices");
    view.innerHTML = `<div class="empty-state">Loading…</div>`;
    const pr = periodRange();
    const q = buildQuery({
        branchId: session.role === "ADMIN" ? (currentBranchId || "all") : null,
        from: pr.from, to: pr.to
    });
    try {
        if (invoicesSubTab === "returns") {
            const refunds = await api.get("/api/refunds" + q);
            renderRefundsList(refunds);
        } else {
            const list = await api.get("/api/invoices" + q);
            renderInvoices(list, "");
        }
    } catch (e) { view.innerHTML = `<div class="empty-state">Could not load ${invoicesSubTab === "returns" ? "returns" : "invoices"}.</div>`; }
}

function renderInvoices(all, filter) {
    const q = (filter || "").toLowerCase();
    const list = all.filter(inv => !q
        || inv.invoiceNo.toLowerCase().includes(q)
        || (inv.customerName || "").toLowerCase().includes(q)
        || (inv.cashierUsername || "").toLowerCase().includes(q));
    const showBranch = session.role === "ADMIN" && !currentBranchId;
    const periodTotal = all.reduce((sum, inv) => sum + Number(inv.grandTotal || 0), 0);
    const view = document.getElementById("view-invoices");
    view.innerHTML = `
        ${invoicesSubTabs()}
        <div class="toolbar">
            <input class="input search" id="invSearch" placeholder="Search invoice no / customer / cashier…" value="${esc(filter || "")}">
            ${periodControl()}
            <div class="spacer"></div>
            <span class="mini-sub">${all.length} invoice(s) · <b>${money(periodTotal)}</b></span>
        </div>
        <div class="card"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>Invoice No</th>${showBranch ? "<th>Branch</th>" : ""}<th>Date</th><th>Customer</th><th>Cashier</th><th>Payment</th>
                <th class="num">Items</th><th class="num">Grand Total</th><th></th></tr></thead>
            <tbody>${list.length ? list.map(inv => `
                <tr>
                    <td><b>${esc(inv.invoiceNo)}</b></td>
                    ${showBranch ? `<td>${esc(inv.branchName)}</td>` : ""}
                    <td>${esc(inv.dateTime)}</td>
                    <td>${esc(inv.customerName)}</td>
                    <td>${esc(inv.cashierUsername)}</td>
                    <td>${esc(inv.paymentMode)}</td>
                    <td class="num">${inv.itemCount}</td>
                    <td class="num money">${money(inv.grandTotal)}</td>
                    <td class="num"><div class="btn-group">
                        <button class="btn btn-sm" data-pdf="${esc(inv.pdfUrl)}">📄 A4</button>
                        <button class="btn btn-sm" data-pdf="${esc(inv.thermalPdfUrl)}">🧾 Receipt</button>
                        ${session.role !== "CASHIER" ? `<button class="btn btn-sm btn-warn" data-return="${esc(inv.invoiceNo)}">↩ Return</button>` : ""}
                    </div></td>
                </tr>`).join("") : `<tr><td colspan="${showBranch ? 8 : 7}"><div class="empty-state"><div class="big">📁</div>No invoices yet. Create a bill to get started.</div></td></tr>`}
            </tbody>
        </table></div></div>`;

    wireInvoicesSubTabs();
    wirePeriodControl(view, loadInvoices);
    const s = document.getElementById("invSearch");
    s.addEventListener("input", debounced(e => renderInvoices(all, e.target.value), 120));
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
    view.querySelectorAll("button[data-pdf]").forEach(b =>
        b.onclick = () => window.open(b.dataset.pdf, "_blank"));
    view.querySelectorAll("button[data-return]").forEach(b =>
        b.onclick = () => openReturnModal(b.dataset.return));
}

function invoicesSubTabs() {
    return `<div class="admin-tabs" id="invSubTabs">
        <button class="admin-tab ${invoicesSubTab === "sales" ? "active" : ""}" data-sub="sales">Sales</button>
        <button class="admin-tab ${invoicesSubTab === "returns" ? "active" : ""}" data-sub="returns">Returns</button>
    </div>`;
}
function wireInvoicesSubTabs() {
    document.querySelectorAll("#invSubTabs .admin-tab").forEach(b => b.onclick = () => {
        if (b.dataset.sub === invoicesSubTab) return;
        invoicesSubTab = b.dataset.sub;
        loadInvoices();
    });
}

function renderRefundsList(refunds) {
    const showBranch = session.role === "ADMIN" && !currentBranchId;
    const total = refunds.reduce((s, r) => s + Number(r.refundAmount || 0), 0);
    const view = document.getElementById("view-invoices");
    view.innerHTML = `
        ${invoicesSubTabs()}
        <div class="toolbar">
            ${periodControl()}
            <div class="spacer"></div>
            <span class="mini-sub">${refunds.length} refund(s) · <b>${money(total)}</b></span>
        </div>
        <div class="card"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>Refund No</th>${showBranch ? "<th>Branch</th>" : ""}<th>Date</th><th>Original Invoice</th><th>Cashier</th><th>Reason</th><th class="num">Items</th><th class="num">Refunded</th></tr></thead>
            <tbody>${refunds.length ? refunds.map(r => `
                <tr>
                    <td><b>${esc(r.refundNo)}</b></td>
                    ${showBranch ? `<td>${esc(r.branchName)}</td>` : ""}
                    <td>${esc(r.dateTime)}</td>
                    <td>${esc(r.originalInvoiceNo)}</td>
                    <td>${esc(r.cashierUsername)}</td>
                    <td>${esc(r.reason || "—")}</td>
                    <td class="num">${r.itemCount}</td>
                    <td class="num money" style="color:var(--red)">− ${money(r.refundAmount)}</td>
                </tr>`).join("") : `<tr><td colspan="${showBranch ? 8 : 7}"><div class="empty-state"><div class="big">↩</div>No refunds yet.</div></td></tr>`}
            </tbody>
        </table></div></div>`;
    wireInvoicesSubTabs();
    wirePeriodControl(view, loadInvoices);
}

async function openReturnModal(invoiceNo) {
    let inv;
    try { inv = await api.get("/api/invoices/" + encodeURIComponent(invoiceNo) + "/refundable"); }
    catch (e) { toast(e.message, "error"); return; }
    if (!inv.anyRefundable) {
        toast("Nothing left to refund on " + invoiceNo, "error");
        return;
    }
    const rows = inv.lines.map((l, i) => {
        const disabled = l.remaining <= 0 ? "disabled" : "";
        return `<tr class="${l.remaining <= 0 ? "muted" : ""}">
            <td><b>${esc(l.name)}</b><div class="mini-sub">${esc(l.itemId)}</div></td>
            <td class="num">${fmtQty(l.originalQuantity)} ${esc(l.unit)}</td>
            <td class="num">${l.alreadyRefunded > 0 ? fmtQty(l.alreadyRefunded) : "—"}</td>
            <td class="num"><b>${fmtQty(l.remaining)}</b></td>
            <td class="num">
                <input class="input rq" data-i="${i}" type="number" min="0" step="1"
                    max="${l.remaining}" value="0" ${disabled} style="width:78px;text-align:right">
            </td>
        </tr>`;
    }).join("");
    openModal(`
        <div class="modal" style="max-width:640px">
            <div class="modal-head"><h3>Return items from ${esc(inv.invoiceNo)}</h3>
                <button class="modal-close" id="mClose">×</button></div>
            <div class="modal-body">
                <div class="mini-sub" style="margin-bottom:12px">
                    ${esc(inv.customerName)} • ${esc(inv.dateTime)} • ${esc(inv.paymentMode)} • Bill total ${money(inv.grandTotal)}
                </div>
                <div class="table-wrap"><table class="tbl">
                    <thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Refunded</th><th class="num">Left</th><th class="num">Return Qty</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>
                <div class="field" style="margin-top:14px"><label for="rfReason">Reason (optional)</label>
                    <input class="input" id="rfReason" placeholder="e.g. Damaged pack, wrong item, changed mind"></div>
                <div class="totals" style="margin-top:14px">
                    <div class="total-row grand"><span>Refund Total</span><span id="rfTotal">${money(0)}</span></div>
                </div>
            </div>
            <div class="modal-foot">
                <button class="btn" id="mCancel">Cancel</button>
                <button class="btn btn-danger" id="mSave" disabled>Process Refund</button>
            </div>
        </div>`);
    const totalEl = document.getElementById("rfTotal");
    const saveBtn = document.getElementById("mSave");
    const inputs = [...document.querySelectorAll(".rq")];
    const recompute = () => {
        let t = 0;
        inputs.forEach(inp => {
            const l = inv.lines[+inp.dataset.i];
            let q = Math.max(0, parseFloat(inp.value) || 0);
            if (q > l.remaining) { q = l.remaining; inp.value = q; }
            t += q * l.price * (1 + l.taxRatePercent / 100);
        });
        totalEl.textContent = money(t);
        saveBtn.disabled = t <= 0;
    };
    inputs.forEach(inp => inp.addEventListener("input", recompute));
    document.getElementById("mClose").onclick = closeModal;
    document.getElementById("mCancel").onclick = closeModal;
    saveBtn.onclick = () => withBusy(saveBtn, "Processing…", async () => {
        const body = {
            originalInvoiceNo: inv.invoiceNo,
            reason: document.getElementById("rfReason").value.trim(),
            lines: inputs.map(inp => ({
                itemId: inv.lines[+inp.dataset.i].itemId,
                quantity: Math.max(0, parseFloat(inp.value) || 0)
            })).filter(l => l.quantity > 0)
        };
        try {
            const r = await api.post("/api/refunds", body);
            closeModal();
            toast(`Refund ${r.refundNo} processed — ${money(r.refundAmount)}`, "success");
            loadInvoices();
        } catch (e) { toast(e.message, "error"); }
    });
}

/* ============================================================
   ADMIN: branches, users, audit log, backup
   ============================================================ */
// Day Report moved to its own top-level nav item (every role gets their own branch's
// report, not just Admin) - these tabs are the genuinely admin-only management screens.
const ADMIN_TABS = [["branches", "Branches"], ["users", "Users"], ["audit", "Audit Log"], ["backup", "Backup"]];

function renderAdminTab(tab) {
    currentAdminTab = tab;
    const view = document.getElementById("view-admin");
    view.innerHTML = `
        <div class="admin-tabs">
            ${ADMIN_TABS.map(([key, label]) => `<button class="admin-tab ${tab === key ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}
        </div>
        <div id="adminTabBody"></div>`;
    view.querySelectorAll(".admin-tab").forEach(b => b.onclick = () => renderAdminTab(b.dataset.tab));
    const body = document.getElementById("adminTabBody");
    if (tab === "branches") renderBranchesTab(body);
    else if (tab === "users") renderUsersTab(body);
    else if (tab === "audit") renderAuditTab(body);
    else if (tab === "backup") renderBackupTab(body);
}

async function renderBranchesTab(body) {
    body.innerHTML = `<div class="empty-state">Loading…</div>`;
    let list;
    try { list = await api.get("/api/branches"); } catch (e) { body.innerHTML = `<div class="empty-state">Could not load branches.</div>`; return; }
    body.innerHTML = `
        <div class="toolbar"><div class="spacer"></div><button class="btn btn-primary" id="addBranchBtn">＋ Add Branch</button></div>
        <div class="card"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>ID</th><th>Name</th><th>Address</th><th>Phone</th><th>GSTIN</th><th>Status</th><th></th></tr></thead>
            <tbody>${list.map(b => `
                <tr>
                    <td>${esc(b.id)}</td>
                    <td><b>${esc(b.name)}</b></td>
                    <td>${esc(b.addressLine1)}${b.addressLine2 ? ", " + esc(b.addressLine2) : ""}</td>
                    <td>${esc(b.phone)}</td>
                    <td>${esc(b.gstin)}</td>
                    <td><span class="pill ${b.active ? "ok" : "danger"}">${b.active ? "Active" : "Inactive"}</span></td>
                    <td class="num"><button class="btn btn-sm" data-edit="${esc(b.id)}">Edit</button></td>
                </tr>`).join("")}
            </tbody>
        </table></div></div>`;
    document.getElementById("addBranchBtn").onclick = () => openBranchModal(null, list);
    body.querySelectorAll("button[data-edit]").forEach(btn =>
        btn.onclick = () => openBranchModal(list.find(x => x.id === btn.dataset.edit), list));
}

function openBranchModal(branch, allBranches) {
    const editing = !!branch;
    openModal(`
        <div class="modal">
            <div class="modal-head"><h3>${editing ? "Edit" : "Add"} Branch</h3><button class="modal-close" id="mClose">×</button></div>
            <div class="modal-body">
                <div class="field"><label for="fbName">Name *</label><input class="input" id="fbName" value="${editing ? esc(branch.name) : ""}"></div>
                <div class="field"><label for="fbAddr1">Address Line 1</label><input class="input" id="fbAddr1" value="${editing ? esc(branch.addressLine1) : ""}"></div>
                <div class="field"><label for="fbAddr2">Address Line 2</label><input class="input" id="fbAddr2" value="${editing ? esc(branch.addressLine2) : ""}"></div>
                <div class="field-row">
                    <div class="field"><label for="fbPhone">Phone</label><input class="input" id="fbPhone" value="${editing ? esc(branch.phone) : ""}"></div>
                    <div class="field"><label for="fbGstin">GSTIN</label><input class="input" id="fbGstin" value="${editing ? esc(branch.gstin) : ""}"></div>
                </div>
                <div class="field"><label for="fbStateCode">State Code
                        <span class="mini-sub">— for GST place-of-supply (e.g. TN, KA, MH)</span></label>
                    <input class="input" id="fbStateCode" maxlength="4" style="text-transform:uppercase"
                        value="${editing ? esc(branch.stateCode || "") : ""}"></div>
                ${editing
                    ? `<div class="field"><label for="fbActive">Status</label>
                        <select class="input" id="fbActive">
                            <option value="true" ${branch.active ? "selected" : ""}>Active</option>
                            <option value="false" ${!branch.active ? "selected" : ""}>Inactive</option>
                        </select></div>`
                    : `<div class="field"><label for="fbClone">Starting catalogue</label>
                        <select class="input" id="fbClone">
                            <option value="">Start empty</option>
                            ${allBranches.map(b => `<option value="${esc(b.id)}">Copy products from ${esc(b.name)}</option>`).join("")}
                        </select></div>`}
            </div>
            <div class="modal-foot">
                <button class="btn" id="mCancel">Cancel</button>
                <button class="btn btn-primary" id="mSave">${editing ? "Save Changes" : "Add Branch"}</button>
            </div>
        </div>`);
    document.getElementById("mClose").onclick = closeModal;
    document.getElementById("mCancel").onclick = closeModal;
    document.getElementById("mSave").onclick = () => withBusy(document.getElementById("mSave"), "Saving…", async () => {
        const dto = {
            name: document.getElementById("fbName").value.trim(),
            addressLine1: document.getElementById("fbAddr1").value.trim(),
            addressLine2: document.getElementById("fbAddr2").value.trim(),
            phone: document.getElementById("fbPhone").value.trim(),
            gstin: document.getElementById("fbGstin").value.trim(),
            stateCode: document.getElementById("fbStateCode").value.trim().toUpperCase()
        };
        if (!dto.name) { toast("Branch name is required", "error"); return; }
        try {
            if (editing) {
                dto.active = document.getElementById("fbActive").value === "true";
                await api.put("/api/branches/" + encodeURIComponent(branch.id), dto);
            } else {
                dto.cloneFromBranchId = document.getElementById("fbClone").value;
                await api.post("/api/branches", dto);
            }
            closeModal();
            toast("Branch saved", "success");
            branches = await api.get("/api/branches");
            setupBranchSwitcher();
            renderAdminTab("branches");
        } catch (e) { toast(e.message, "error"); }
    });
}

async function renderUsersTab(body) {
    body.innerHTML = `<div class="empty-state">Loading…</div>`;
    let list;
    try { list = await api.get("/api/users"); } catch (e) { body.innerHTML = `<div class="empty-state">Could not load users.</div>`; return; }
    body.innerHTML = `
        <div class="toolbar"><div class="spacer"></div><button class="btn btn-primary" id="addUserBtn">＋ Add User</button></div>
        <div class="card"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Branch</th><th>Status</th><th></th></tr></thead>
            <tbody>${list.map(u => `
                <tr>
                    <td><b>${esc(u.username)}</b></td>
                    <td>${esc(u.fullName)}</td>
                    <td><span class="role-badge ${esc(u.role)}">${esc(u.role)}</span></td>
                    <td>${esc(u.branchName)}</td>
                    <td><span class="pill ${u.active ? "ok" : "danger"}">${u.active ? "Active" : "Inactive"}</span></td>
                    <td class="num"><button class="btn btn-sm" data-edit="${esc(u.username)}">Edit</button></td>
                </tr>`).join("")}
            </tbody>
        </table></div></div>`;
    document.getElementById("addUserBtn").onclick = () => openUserModal(null);
    body.querySelectorAll("button[data-edit]").forEach(btn =>
        btn.onclick = () => openUserModal(list.find(x => x.username === btn.dataset.edit)));
}

function openUserModal(user) {
    const editing = !!user;
    const roles = ["ADMIN", "MANAGER", "CASHIER"];
    openModal(`
        <div class="modal">
            <div class="modal-head"><h3>${editing ? "Edit" : "Add"} User</h3><button class="modal-close" id="mClose">×</button></div>
            <div class="modal-body">
                <div class="field"><label for="fuUsername">Username *</label>
                    <input class="input" id="fuUsername" ${editing ? "disabled" : ""} value="${editing ? esc(user.username) : ""}"></div>
                <div class="field"><label for="fuFullName">Full Name</label><input class="input" id="fuFullName" value="${editing ? esc(user.fullName) : ""}"></div>
                <div class="field-row">
                    <div class="field"><label for="fuRole">Role</label>
                        <select class="input" id="fuRole">${roles.map(r => `<option ${editing && user.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>
                    <div class="field"><label for="fuBranch">Branch <span class="mini-sub">(not needed for Admin)</span></label>
                        <select class="input" id="fuBranch">
                            <option value="">—</option>
                            ${branches.map(b => `<option value="${esc(b.id)}" ${editing && user.branchId === b.id ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
                        </select></div>
                </div>
                <div class="field"><label for="fuPassword">${editing ? "Reset Password" : "Password *"}</label>
                    <input class="input" id="fuPassword" type="password" placeholder="${editing ? "Leave blank to keep current password" : "At least 6 characters"}"></div>
                ${editing ? `<div class="field"><label for="fuActive">Status</label>
                    <select class="input" id="fuActive">
                        <option value="true" ${user.active ? "selected" : ""}>Active</option>
                        <option value="false" ${!user.active ? "selected" : ""}>Inactive</option>
                    </select></div>` : ""}
            </div>
            <div class="modal-foot">
                <button class="btn" id="mCancel">Cancel</button>
                <button class="btn btn-primary" id="mSave">${editing ? "Save Changes" : "Add User"}</button>
            </div>
        </div>`);
    document.getElementById("mClose").onclick = closeModal;
    document.getElementById("mCancel").onclick = closeModal;
    document.getElementById("mSave").onclick = () => withBusy(document.getElementById("mSave"), "Saving…", async () => {
        const dto = {
            username: editing ? user.username : document.getElementById("fuUsername").value.trim(),
            fullName: document.getElementById("fuFullName").value.trim(),
            role: document.getElementById("fuRole").value,
            branchId: document.getElementById("fuBranch").value,
            password: document.getElementById("fuPassword").value,
            active: editing ? document.getElementById("fuActive").value === "true" : true
        };
        if (!dto.username) { toast("Username is required", "error"); return; }
        if (!editing && dto.password.length < 6) { toast("Password must be at least 6 characters", "error"); return; }
        try {
            if (editing) await api.put("/api/users/" + encodeURIComponent(user.username), dto);
            else await api.post("/api/users", dto);
            closeModal();
            toast("User saved", "success");
            renderAdminTab("users");
        } catch (e) { toast(e.message, "error"); }
    });
}

async function renderAuditTab(body) {
    body.innerHTML = `<div class="empty-state">Loading…</div>`;
    let list;
    try { list = await api.get("/api/audit-log"); } catch (e) { body.innerHTML = `<div class="empty-state">Could not load audit log.</div>`; return; }
    body.innerHTML = `
        <div class="card"><div class="table-wrap"><table class="tbl">
            <thead><tr><th>When</th><th>User</th><th>Role</th><th>Branch</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>${list.length ? list.map(e => `
                <tr>
                    <td>${esc(e.when)}</td>
                    <td>${esc(e.username)}</td>
                    <td>${e.role ? `<span class="role-badge ${esc(e.role)}">${esc(e.role)}</span>` : ""}</td>
                    <td>${esc(branchNameOf(e.branchId))}</td>
                    <td>${esc(e.action)}</td>
                    <td>${esc(e.details)}</td>
                </tr>`).join("") : `<tr><td colspan="6"><div class="empty-state">No activity recorded yet.</div></td></tr>`}
            </tbody>
        </table></div></div>`;
}
function branchNameOf(id) {
    if (!id) return "—";
    const b = branches.find(x => x.id === id);
    return b ? b.name : id;
}

async function renderZReportTab(body) {
    const today = ymd(new Date());
    const savedDate = body.dataset.zdate || today;
    // Admin can pick any branch (or all combined); Manager/Cashier are pinned to their own
    // branch server-side regardless of what's sent, so there's nothing for them to pick -
    // the `branches` list is never even loaded for non-admins (see bootApp), so reusing the
    // admin picker as-is would render an empty, misleading dropdown.
    const isAdmin = session.role === "ADMIN";
    body.innerHTML = `
        <div class="toolbar no-print">
            <div class="field" style="max-width:180px;margin:0"><label for="zDate">Date</label>
                <input class="input" id="zDate" type="date" value="${esc(savedDate)}" max="${today}"></div>
            ${isAdmin ? `<div class="field" style="max-width:220px;margin:0"><label for="zBranch">Branch</label>
                <select class="input" id="zBranch"></select></div>` : ""}
            <div class="spacer"></div>
            <button class="btn" id="zPrint">🖨️ Print</button>
        </div>
        <div id="zReportBody"><div class="empty-state">Loading…</div></div>`;

    const load = async () => {
        const d = document.getElementById("zDate").value || today;
        const b = isAdmin ? document.getElementById("zBranch").value : session.branchId;
        body.dataset.zdate = d;
        try {
            const z = await api.get("/api/reports/z" + buildQuery({ date: d, branchId: b }));
            renderZReport(document.getElementById("zReportBody"), z);
        } catch (e) {
            document.getElementById("zReportBody").innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
        }
    };
    if (isAdmin) {
        // Branch picker: pre-filled with everything the current admin can see.
        const sel = document.getElementById("zBranch");
        sel.innerHTML = `<option value="all">All Branches</option>` +
            branches.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
        sel.value = currentBranchId || "all";
        sel.onchange = load;
    }
    document.getElementById("zDate").onchange = load;
    document.getElementById("zPrint").onclick = () => window.print();
    load();
}

function renderZReport(root, z) {
    // "Net cash owed" line: for now cashInDrawer == cashSales (there is no float / cash
    // drop feature yet), but showing it explicitly makes end-of-day reconciliation obvious.
    const totalNonCash = z.byPayment.filter(p => p.mode.toLowerCase() !== "cash").reduce((s, p) => s + p.amount, 0);
    root.innerHTML = `
        <div class="card z-report">
            <div class="z-header">
                <div>
                    <div class="z-title">Day-End Z-Report</div>
                    <div class="mini-sub">${esc(z.branchName)} · ${esc(z.date)}</div>
                </div>
                <div class="z-stamp">
                    <div class="mini-sub">${esc(store.name)}</div>
                    <div class="mini-sub">Printed ${esc(new Date().toLocaleString("en-IN"))}</div>
                </div>
            </div>
            <div class="z-grid">
                <div class="z-tile">
                    <div class="z-tile-label">Net Sales</div>
                    <div class="z-tile-value">${money(z.netSales)}</div>
                    <div class="mini-sub">Gross ${money(z.grandTotal)} − Refunds ${money(z.refundTotal)}</div>
                </div>
                <div class="z-tile">
                    <div class="z-tile-label">Cash in Drawer</div>
                    <div class="z-tile-value">${money(z.cashInDrawer)}</div>
                    <div class="mini-sub">Non-cash: ${money(totalNonCash)}</div>
                </div>
                <div class="z-tile">
                    <div class="z-tile-label">GST Collected</div>
                    <div class="z-tile-value">${money(z.cgst + z.sgst + (z.igst || 0))}</div>
                    <div class="mini-sub">${z.igst > 0
                        ? `CGST ${money(z.cgst)} · SGST ${money(z.sgst)} · IGST ${money(z.igst)}`
                        : `CGST ${money(z.cgst)} · SGST ${money(z.sgst)}`}</div>
                </div>
                <div class="z-tile">
                    <div class="z-tile-label">Invoice Range</div>
                    <div class="z-tile-value" style="font-size:20px">${esc(z.firstInvoiceNo || "—")}</div>
                    <div class="mini-sub">to ${esc(z.lastInvoiceNo || "—")}</div>
                </div>
            </div>

            <h4 class="z-h">Totals</h4>
            <table class="tbl z-tbl">
                <tbody>
                    <tr><td>Sub Total</td><td class="num money">${money(z.subTotal)}</td></tr>
                    <tr><td>Discounts</td><td class="num money">− ${money(z.discount)}</td></tr>
                    <tr><td>CGST</td><td class="num money">${money(z.cgst)}</td></tr>
                    <tr><td>SGST</td><td class="num money">${money(z.sgst)}</td></tr>
                    ${z.igst > 0 ? `<tr><td>IGST</td><td class="num money">${money(z.igst)}</td></tr>` : ""}
                    <tr><td>Round Off</td><td class="num money">${z.roundOff >= 0 ? "+ " : "− "}${money(Math.abs(z.roundOff))}</td></tr>
                    <tr class="z-total"><td><b>Gross Total</b></td><td class="num money"><b>${money(z.grandTotal)}</b></td></tr>
                    <tr><td>Refunds (${z.refundCount})</td><td class="num money" style="color:var(--red)">− ${money(z.refundTotal)}</td></tr>
                    <tr class="z-total"><td><b>Net Sales</b></td><td class="num money" style="color:var(--green-dark)"><b>${money(z.netSales)}</b></td></tr>
                </tbody>
            </table>

            <h4 class="z-h">Payment Breakdown</h4>
            <table class="tbl z-tbl">
                <thead><tr><th>Mode</th><th class="num">Invoices</th><th class="num">Amount</th></tr></thead>
                <tbody>${z.byPayment.length ? z.byPayment.map(p => `
                    <tr><td>${esc(p.mode)}</td><td class="num">${p.count}</td><td class="num money">${money(p.amount)}</td></tr>`).join("")
                    : `<tr><td colspan="3"><div class="mini-sub" style="padding:6px 0">No sales.</div></td></tr>`}
                </tbody>
            </table>

            <h4 class="z-h">Top Items (by revenue)</h4>
            <table class="tbl z-tbl">
                <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
                <tbody>${z.topItems.length ? z.topItems.map((t, i) => `
                    <tr><td>${i + 1}</td><td>${esc(t.name)}</td>
                        <td class="num">${fmtQty(t.quantity)} ${esc(t.unit || "")}</td>
                        <td class="num money">${money(t.amount)}</td></tr>`).join("")
                    : `<tr><td colspan="4"><div class="mini-sub" style="padding:6px 0">No sales.</div></td></tr>`}
                </tbody>
            </table>
        </div>`;
}

function renderBackupTab(body) {
    body.innerHTML = `
        <div class="card settings-card">
            <div class="card-head"><div class="card-title">Data Backup</div></div>
            <div class="card-body">
                <p class="mini-sub" style="margin:0 0 14px">Everything lives in a single SQLite file at <code>data/freshmart.db</code>.
                    Download a zip any time. The app also keeps a dated copy under <code>data/backups/</code>
                    automatically — now <b>every day the server is running</b>, not just the day it started.</p>
                <button class="btn btn-primary" id="downloadBackupBtn">⬇ Download Backup (.zip)</button>
            </div>
        </div>
        <div class="card settings-card" style="margin-top:16px">
            <div class="card-head"><div class="card-title">Restore from Backup</div></div>
            <div class="card-body">
                <p class="mini-sub" style="margin:0 0 14px">Replace <b>all current data</b> with a backup zip you
                    downloaded earlier. For safety the restore is <b>staged</b> and takes effect the next time the app
                    starts; your current data is copied to <code>data/backups/pre-restore-…</code> first.</p>
                <div class="field" style="max-width:420px">
                    <input class="input" id="restoreFile" type="file" accept=".zip,application/zip">
                </div>
                <button class="btn btn-danger" id="restoreBtn">⬆ Restore from this backup</button>
            </div>
        </div>`;
    document.getElementById("downloadBackupBtn").onclick = () => window.open("/api/admin/backup", "_blank");
    document.getElementById("restoreBtn").onclick = () => {
        const input = document.getElementById("restoreFile");
        const file = input.files && input.files[0];
        if (!file) { toast("Choose a backup .zip first", "error"); return; }
        confirmAction({
            title: "Restore from backup?",
            message: `This will replace <b>all current data</b> with <b>${esc(file.name)}</b> when the app next starts.
                Your current data is saved to a pre-restore folder first. Continue?`,
            confirmLabel: "Stage Restore",
            busyLabel: "Uploading…",
            onConfirm: async () => {
                const buf = await file.arrayBuffer();
                const res = await fetch("/api/admin/restore", {
                    method: "POST",
                    headers: { "Content-Type": "application/octet-stream" },
                    body: buf
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || "Restore failed");
                closeModal();
                openModal(`
                    <div class="modal" style="max-width:420px">
                        <div class="modal-head"><h3>Restore staged</h3></div>
                        <div class="modal-body"><p class="mini-sub" style="margin:0">${esc(data.message || "Restart the app to complete the restore.")}</p></div>
                        <div class="modal-foot"><button class="btn btn-primary" id="restoreOkBtn">Got it</button></div>
                    </div>`);
                document.getElementById("restoreOkBtn").onclick = closeModal;
            }
        });
    };
}

/* ============================================================
   STARTUP
   ============================================================ */
function startClock() {
    const el = document.getElementById("clock");
    const tick = () => {
        const d = new Date();
        el.textContent = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
            + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    };
    tick();
    setInterval(tick, 1000);
}

/** The active branch's identity block, if we can pin one down; else the store-wide fallback.
 *  ADMIN with "All Branches" gets the store info; ADMIN with a branch picked gets that branch
 *  (from the already-loaded `branches` list); Manager/Cashier get their own branch (from session). */
function activeAddressBlock() {
    if (session && session.role === "ADMIN") {
        if (!currentBranchId) return null;
        const b = branches.find(x => x.id === currentBranchId);
        if (b) {
            return { name: b.name, addressLine1: b.addressLine1, addressLine2: b.addressLine2,
                     phone: b.phone, gstin: b.gstin };
        }
        return null;
    }
    if (session && session.branchId) {
        return { name: session.branchName, addressLine1: session.branchAddressLine1,
                 addressLine2: session.branchAddressLine2, phone: session.branchPhone,
                 gstin: session.branchGstin };
    }
    return null;
}

function renderStoreFooter() {
    const b = activeAddressBlock();
    const name = b ? b.name : store.name;
    const line1 = b ? (b.addressLine1 || "") : (store.addressLine1 || "");
    const line2 = b ? (b.addressLine2 || "") : (store.addressLine2 || "");
    const phone = b ? (b.phone || "") : (store.phone || "");
    const gstin = b ? (b.gstin || "") : (store.gstin || "");
    document.getElementById("storeFooter").innerHTML = `
        <div><b>${esc(name)}</b></div>
        <div>${esc(line1)}</div>
        <div>${esc(line2)}</div>
        <div>☎ ${esc(phone)}</div>
        <div>GSTIN: ${esc(gstin)}</div>`;
}

async function bootApp() {
    applyRoleVisibility();
    // Apply the user's saved theme immediately so we don't flash the wrong palette.
    // Their default reporting period (if set) also wins over whatever the previous session left in localStorage.
    applyThemePreference();
    const userSettings = loadUserSettings();
    if (userSettings.defaultPeriod) {
        reportPeriod = userSettings.defaultPeriod;
        localStorage.setItem("fm_period", reportPeriod);
    }
    try {
        store = await api.get("/api/store");
        document.getElementById("brandName").textContent = (store.name || "FreshMart").split(" ")[0];
    } catch (e) { toast("Could not load store info", "error"); }
    // The full branch list (address/phone/GSTIN of every branch) is admin-only server-side;
    // Manager/Cashier already know their own branch from /api/auth/me and never need this.
    try { branches = session.role === "ADMIN" ? await api.get("/api/branches") : []; } catch (e) { branches = []; }
    renderUserBox();
    setupBranchSwitcher();
    // Render the footer AFTER the branch is known, so the address block reflects the
    // active branch (admin's saved pick or the non-admin's own branch) instead of the
    // store-wide default.
    renderStoreFooter();
    try { await loadItems(); } catch (e) { /* shown per-view */ }
    // Honour the user's chosen landing view. Guard against a stale value naming a view they
    // no longer have access to (e.g. cashier saved "products" then role was demoted).
    const landing = userSettings.defaultView;
    const canLand = landing === "dashboard"
        || (landing === "products" && session.role !== "CASHIER")
        || (landing === "admin" && session.role === "ADMIN")
        || ["billing", "invoices", "dayreport", "settings"].includes(landing);
    switchView(canLand ? landing : "dashboard");
}

async function init() {
    document.querySelectorAll(".nav-item").forEach(b =>
        b.addEventListener("click", () => switchView(b.dataset.view)));
    document.getElementById("loginForm").addEventListener("submit", doLogin);
    const pwToggle = document.getElementById("loginPwToggle");
    pwToggle.addEventListener("click", () => {
        const inp = document.getElementById("loginPassword");
        const reveal = inp.type === "password";
        inp.type = reveal ? "text" : "password";
        pwToggle.textContent = reveal ? "Hide" : "Show";
        pwToggle.setAttribute("aria-pressed", String(reveal));
        pwToggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
        inp.focus();
    });
    document.getElementById("logoutBtn").addEventListener("click", confirmLogout);
    document.getElementById("changePasswordBtn").addEventListener("click", () => openChangePasswordModal(false));
    // An in-progress bill lives only in memory - warn before an accidental tab close
    // or refresh silently throws it away. Most browsers show their own generic text
    // instead of e.returnValue, but triggering the native prompt at all is the part
    // that matters here.
    window.addEventListener("beforeunload", e => {
        if (cart.length > 0) {
            e.preventDefault();
            e.returnValue = "";
        }
    });
    startClock();

    try {
        session = await api.get("/api/auth/me");
        showApp();
        await bootApp();
        if (session.mustChangePassword) {
            openChangePasswordModal(true);
        }
    } catch (e) {
        showLogin();
        try {
            const info = await api.get("/api/store");
            document.getElementById("loginStoreName").textContent = info.name || "FreshMart";
        } catch (e2) { /* ignore - default name stays */ }
    }
}

document.addEventListener("DOMContentLoaded", init);
