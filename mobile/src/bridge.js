/*
 * Runs the shared web UI (web/js/app.js) as a standalone phone app.
 *
 * app.js talks to the server with fetch("/api/...") and opens PDFs / backups / CSVs with
 * window.open("/api/..."). Here both are redirected to the on-device backend (backend.js), so
 * app.js runs unchanged: every /api request is answered locally, the database is saved to the
 * phone's storage after each change, and files are handed to Android's share sheet (print,
 * WhatsApp, Drive, email...) instead of a browser tab.
 *
 * Load order in the mobile index.html: capacitor.js, sql-wasm.js, pdf.js, zip.js, backend.js,
 * bridge.js, then app.js.
 */
(function () {
    "use strict";

    window.FM_LOCAL = true;

    const Cap = window.Capacitor;
    const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
    const plugin = name => (isNative && Cap.registerPlugin ? Cap.registerPlugin(name) : null);
    const Filesystem = plugin("Filesystem");
    const Share = plugin("Share");
    const App = plugin("App");
    const Biometric = plugin("NativeBiometric");

    // ---------------- storage: IndexedDB (survives app restarts and updates) ----------------

    const DB_NAME = "freshmart";
    const STORE = "kv";
    let idbPromise = null;
    function idb() {
        if (!idbPromise) {
            idbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        return idbPromise;
    }
    async function idbGet(key) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
            r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
            r.onerror = () => reject(r.error);
        });
    }
    /** Writes several keys in ONE transaction, so the database and store details never drift apart. */
    async function idbPutAll(entries) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            const os = tx.objectStore(STORE);
            for (const [k, v] of entries) os.put(v, k);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error("Storage write aborted"));
        });
    }

    async function save(changes, extra) {
        const entries = extra ? extra.slice() : [];
        if (changes.db) entries.push(["db", changes.db]);
        if (changes.props != null) entries.push(["props", changes.props]);
        if (!entries.length) return;
        try {
            await idbPutAll(entries);
        } catch (e) {
            throw new Error("Could not save to this phone's storage (" + (e && e.message || e) + "). Free up space and try again.");
        }
    }

    // ---------------- the signed-in session (the PC keeps it in a 12-hour cookie) ----------------

    const BOOTSTRAP_KEY = "bootstrap-password";
    async function idbDelete(key) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    async function signedIn(backend) {
        if (!sid) return false;
        const r = await backend.handle({ method: "GET", path: "/api/auth/me", query: "", sid });
        return r.status === 200;
    }

    const SID_KEY = "fm_local_sid";
    const SESSIONS_KEY = "fm_local_sessions";
    const readLS = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const writeLS = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
    let sid = readLS(SID_KEY);
    function setSid(v) { sid = v || null; writeLS(SID_KEY, sid); }

    // ---------------- boot ----------------

    const ready = (async () => {
        if (navigator.storage && navigator.storage.persist) {
            try { await navigator.storage.persist(); } catch (e) { /* best effort */ }
        }
        const SQL = await initSqlJs({ locateFile: f => "/vendor/" + f });
        const [dbBytes, propsText] = await Promise.all([idbGet("db"), idbGet("props")]);
        const backend = await FMBackend.create({
            SQL,
            dbBytes: dbBytes ? new Uint8Array(dbBytes) : null,
            propsText,
            singleShop: true,
            remoteIp: "127.0.0.1",
            takeSafetyCopy: ({ db, props }) => idbPutAll([["db.pre-restore", db], ["props.pre-restore", props]]),
        });
        let saved = [];
        try { saved = JSON.parse(readLS(SESSIONS_KEY) || "[]"); } catch (e) { saved = []; }
        backend.loadSessions(saved);
        // First launch: there is no console to show the generated admin password on, so the app
        // signs the owner in with it and the forced "Set Your Password" step follows. The password
        // is kept in storage (saved together with the new database) until the owner replaces it,
        // so closing the app before that step can never lock them out.
        const fresh = backend.consumeBootstrapPassword();
        const changes = backend.takeChanges();
        if (changes || fresh) await save(changes || {}, fresh ? [[BOOTSTRAP_KEY, fresh]] : null);
        const firstPassword = fresh || await idbGet(BOOTSTRAP_KEY);
        if (firstPassword && !(await signedIn(backend))) {
            const res = await backend.handle({ method: "POST", path: "/api/auth/login", query: "",
                body: JSON.stringify({ username: "admin", password: firstPassword }) });
            if (res.status === 200) setSid(res.setSid);
            else await idbDelete(BOOTSTRAP_KEY); // replaced already (e.g. restored from a backup)
            const after = backend.takeChanges();
            if (after) await save(after);
        }
        return backend;
    })();
    ready.catch(e => console.error("FreshMart local backend failed to start", e));

    // ---------------- fetch("/api/...") -> local backend ----------------

    const nativeFetch = window.fetch.bind(window);
    async function toBytes(body) {
        if (body == null) return null;
        if (typeof body === "string") return body;
        if (body instanceof ArrayBuffer) return new Uint8Array(body);
        if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
        return String(body);
    }
    window.fetch = async function (input, init) {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return nativeFetch(input, init);
        let backend;
        try {
            backend = await ready;
        } catch (e) {
            return new Response(JSON.stringify({ error: "The app could not open its database: " + (e && e.message || e) }),
                { status: 500, headers: { "Content-Type": "application/json" } });
        }
        const method = (init && init.method) || (typeof input !== "string" && input.method) || "GET";
        const res = await backend.handle({
            method, path: url.pathname, query: url.search.slice(1), sid, body: await toBytes(init && init.body),
        });
        if (res.setSid !== undefined) setSid(res.setSid);
        writeLS(SESSIONS_KEY, JSON.stringify(backend.sessionsSnapshot()));
        if (res.status === 200 && (url.pathname === "/api/auth/change-password" || url.pathname === "/api/admin/restore")) {
            await idbDelete(BOOTSTRAP_KEY); // the generated first-launch password is no longer in use
        }
        const changes = backend.takeChanges();
        if (changes) await save(changes);
        return new Response(res.body, { status: res.status, headers: Object.assign({ "Content-Type": res.contentType }, res.headers) });
    };

    // ---------------- window.open("/api/...pdf|zip|csv") -> share sheet ----------------

    const nativeOpen = window.open.bind(window);
    window.open = function (target, name, features) {
        const url = new URL(String(target), location.href);
        if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
            deliver(url);
            return null;
        }
        return nativeOpen(target, name, features);
    };

    function filenameFrom(disposition, fallback) {
        const m = /filename="?([^";]+)"?/i.exec(disposition || "");
        return m ? m[1] : fallback;
    }
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(",")[1] || "");
            r.onerror = () => reject(r.error);
            r.readAsDataURL(blob);
        });
    }
    function notify(message, type) {
        if (typeof window.toast === "function") window.toast(message, type);
        else alert(message);
    }

    async function deliver(url) {
        try {
            const res = await window.fetch(url.pathname + url.search);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || "Could not open that file.");
            }
            const blob = await res.blob();
            const name = filenameFrom(res.headers.get("Content-Disposition"), url.pathname.split("/").pop() || "file");
            if (isNative && Filesystem && Share) {
                const written = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: "CACHE" });
                try {
                    await Share.share({ title: name, dialogTitle: "Print, save or send " + name, files: [written.uri] });
                } catch (e) {
                    if (!/cancel/i.test(String(e && e.message))) throw e;
                }
                return;
            }
            // Browser preview of the phone build: PDFs open in a tab, everything else downloads.
            const href = URL.createObjectURL(blob);
            if ((res.headers.get("Content-Type") || "").includes("pdf")) {
                nativeOpen(href, "_blank");
            } else {
                const a = document.createElement("a");
                a.href = href;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
            setTimeout(() => URL.revokeObjectURL(href), 60000);
        } catch (e) {
            notify(e.message || String(e), "error");
        }
    }

    // ---------------- "Forgot password?" with the phone's own screen lock ----------------
    // The owner proves it's them with the phone's fingerprint / face / PIN; only then does the
    // local backend accept the new password (backend.deviceReset - not reachable through /api).
    if (Biometric) {
        window.fmDevice = {
            async available() {
                try {
                    const r = await Biometric.isAvailable({ useFallback: true });
                    return !!(r && (r.isAvailable || r.deviceIsSecure));
                } catch (e) { return false; }
            },
            async resetPassword(username, newPassword) {
                try {
                    await Biometric.verifyIdentity({
                        title: "Verify it's you", subtitle: "Reset the FreshMart password for " + username,
                        description: "Use your fingerprint, face or phone PIN",
                        allowedBiometryTypes: [3, 4, 7],   // fingerprint, face, device PIN/pattern
                        maxAttempts: 5,
                    });
                } catch (e) {
                    throw new Error("cancelled");      // backed out or failed - nothing changed
                }
                const backend = await ready;
                const r = await backend.deviceReset(username, newPassword);
                setSid(r.sid);
                writeLS(SESSIONS_KEY, JSON.stringify(backend.sessionsSnapshot()));
                const changes = backend.takeChanges();
                if (changes) await save(changes);
                return r.session;
            },
        };
    }
    if (Share) window.fmShareText = (title, text) => Share.share({ title, text, dialogTitle: title }).catch(() => {});

    // ---------------- Android back button ----------------

    if (App) {
        App.addListener("backButton", () => {
            if (typeof window.m3Back === "function" && window.m3Back()) return;
            const overlay = document.querySelector("#modalRoot .modal-overlay");
            if (overlay) {
                // Same as pressing Escape: closes a dismissible dialog, leaves a required one open.
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                return;
            }
            const inApp = !document.getElementById("appRoot").classList.contains("hidden");
            if (inApp && typeof switchView === "function" && typeof currentView !== "undefined" && currentView !== "dashboard") {
                switchView("dashboard");
                return;
            }
            App.minimizeApp();
        });
    }
})();
