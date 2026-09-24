/*
 * Camera barcode scanning for the Android app (loaded after app.js, m3.js and feel.js).
 *
 * Uses Google's code scanner (ML Kit via @capacitor-mlkit/barcode-scanning): Google's own
 * full-screen scanner UI, delivered through Play Services, no camera permission needed.
 *   - New Bill: scan button in the barcode bar. Each scan adds the item and the scanner
 *     reopens for the next one (continuous checkout); Back in the scanner stops.
 *     An unknown code offers "Add product" with the barcode filled in (managers/admins).
 *   - Products: scan button in the search bar looks the product up.
 *   - Add / Edit Product: scan button next to the Barcode field fills it.
 * Only shown when the scanner is actually available (a real Android phone with Play Services).
 */
(function () {
    "use strict";

    const Cap = window.Capacitor;
    const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
    const Scanner = native && Cap.registerPlugin ? Cap.registerPlugin("BarcodeScanner") : null;
    const $ = s => document.querySelector(s);
    const icon = (n, f) => (window.m3Icon ? window.m3Icon(n, f) : "");
    const buzz = window.fmHaptics || { tap() {}, success() {}, error() {} };
    const FORMATS = ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "CODE_39", "ITF", "CODABAR", "QR_CODE"];

    /** Test hook: window.__fmScanMock = async () => "8901000000017" (or null for cancel). */
    const available = () => !!Scanner || typeof window.__fmScanMock === "function";

    let moduleReady = null;
    async function ensureModule() {
        if (!Scanner) return;
        if (moduleReady) return moduleReady;
        moduleReady = (async () => {
            const { available: ok } = await Scanner.isGoogleBarcodeScannerModuleAvailable();
            if (ok) return;
            toast("Getting the barcode scanner ready… (one-time download)", "info");
            await new Promise((resolve, reject) => {
                let handle;
                Scanner.addListener("googleBarcodeScannerModuleInstallProgress", ev => {
                    // ML Kit install states: 4 = COMPLETED, 5 = CANCELED, 3 = FAILED
                    if (ev.state === 4) { if (handle) handle.remove(); resolve(); }
                    else if (ev.state === 3 || ev.state === 5) { if (handle) handle.remove(); reject(new Error("The barcode scanner could not be downloaded. Check the internet connection and try again.")); }
                }).then(h => { handle = h; });
                Scanner.installGoogleBarcodeScannerModule().catch(reject);
            });
        })();
        moduleReady.catch(() => { moduleReady = null; });
        return moduleReady;
    }

    /** Opens the scanner once. Resolves with the code, or null if the user backed out. */
    async function scanOnce() {
        if (typeof window.__fmScanMock === "function") return window.__fmScanMock();
        await ensureModule();
        try {
            const { barcodes } = await Scanner.scan({ formats: FORMATS, autoZoom: true });
            const b = barcodes && barcodes[0];
            return b ? (b.rawValue || b.displayValue || "").trim() || null : null;
        } catch (e) {
            if (/cancel/i.test(String(e && e.message))) return null;
            throw e;
        }
    }

    // ---------------- New Bill: continuous scanning ----------------
    async function lookup(code) {
        const hits = await api.get("/api/items" + buildQuery({ barcode: code, branchId: adminBranchParam() }));
        return hits[0] || null;
    }
    async function scanToBill() {
        let added = 0;
        try {
            for (;;) {
                const code = await scanOnce();
                if (!code) break;
                const hit = await lookup(code);
                if (!hit) {
                    buzz.error();
                    offerNewProduct(code);
                    break;
                }
                const before = cart.length ? cart.reduce((n, l) => n + l.qty, 0) : 0;
                addToCart(hit.id);
                const after = cart.reduce((n, l) => n + l.qty, 0);
                if (after === before) break;          // out of stock - addToCart already said so
                added++;
                toast(hit.name + " added", "success");
                buzz.success();
                if (typeof window.__fmScanMock === "function" && window.__fmScanOnce) break;
            }
        } catch (e) {
            toast(e.message || String(e), "error");
        }
        return added;
    }
    function offerNewProduct(code) {
        const canAdd = session && session.role !== "CASHIER";
        const root = $("#toastRoot");
        root.querySelectorAll(".toast").forEach(x => x.remove());
        const t = document.createElement("div");
        t.className = "toast info fm-snack";
        t.innerHTML = `<span class="t-msg"></span>${canAdd ? `<button type="button" class="fm-snack-act">Add product</button>` : ""}`;
        t.querySelector(".t-msg").textContent = `No product with barcode ${code}`;
        const close = () => { t.style.opacity = "0"; setTimeout(() => t.remove(), 200); };
        if (canAdd) {
            t.querySelector(".fm-snack-act").onclick = e => {
                e.stopPropagation();
                close();
                openProductModal(null);
                const f = $("#fBarcode");
                if (f) f.value = code;
                const n = $("#fName");
                if (n) n.focus();
            };
        }
        root.appendChild(t);
        setTimeout(close, 7000);
    }

    // ---------------- buttons ----------------
    function scanButton(label, onClick) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "fm-scan-btn";
        b.setAttribute("aria-label", label);
        b.title = label;
        b.innerHTML = icon("barcode_scanner");
        b.onclick = e => { e.preventDefault(); buzz.tap(); onClick(); };
        return b;
    }
    function decorate() {
        if (!available()) return;
        const bar = $(".barcode-bar");
        if (bar && !bar.querySelector(".fm-scan-btn")) {
            bar.appendChild(scanButton("Scan with camera", scanToBill));
            const input = $("#barcodeInput");
            if (input) input.placeholder = "Tap the scanner, or type a barcode / item ID";
        }
        const ps = $("#prodSearch");
        if (ps && !ps.parentElement.querySelector(".fm-scan-btn")) {
            const wrapEl = document.createElement("div");
            wrapEl.className = "fm-scan-field";
            ps.parentElement.insertBefore(wrapEl, ps);
            wrapEl.appendChild(ps);
            wrapEl.appendChild(scanButton("Scan to find a product", async () => {
                try {
                    const code = await scanOnce();
                    if (!code) return;
                    ps.value = code;
                    ps.dispatchEvent(new Event("input", { bubbles: true }));
                } catch (e) { toast(e.message || String(e), "error"); }
            }));
        }
        const fb = $("#fBarcode");
        if (fb && !fb.parentElement.querySelector(".fm-scan-btn")) {
            const wrapEl = document.createElement("div");
            wrapEl.className = "fm-scan-field";
            fb.parentElement.insertBefore(wrapEl, fb);
            wrapEl.appendChild(fb);
            wrapEl.appendChild(scanButton("Scan the product's barcode", async () => {
                try {
                    const code = await scanOnce();
                    if (code) { fb.value = code; buzz.success(); }
                } catch (e) { toast(e.message || String(e), "error"); }
            }));
        }
    }
    new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });

    // Warm the module up in the background so the first scan opens instantly.
    if (Scanner) setTimeout(() => { ensureModule().catch(() => {}); }, 4000);
})();
