/*
 * FreshMart on-device backend - a JavaScript port of the Java server (src/grocery) that runs
 * inside the Android app, so the phone needs no PC. It answers the same /api/... requests with
 * the same JSON, the same status codes and the same error messages as grocery.web.ApiHandler,
 * and keeps its data in the same SQLite schema (via sql.js), so a backup zip from either side
 * restores on the other.
 *
 * Structure mirrors the Java code one-to-one: Db (grocery.util.Db), the services
 * (BranchService, InventoryService, InvoiceStore, RefundService, UserService, AuditLogService,
 * BillingService, SessionManager, LoginRateLimiter, StoreConfig), Mappers, and the router.
 * When changing billing rules, change them in BOTH places - the Java server and this file.
 *
 * Money is held as integer paise (Number) and every rounding step reproduces Java's
 * BigDecimal HALF_UP exactly (products and quotients go through BigInt), so totals match the
 * PC to the paisa. Report figures that the Java code sums as doubles are summed as doubles
 * here too, in the same order, so even their floating-point noise matches.
 *
 * Usage: const backend = await FMBackend.create({ SQL, dbBytes, propsText, ... });
 *        const res = await backend.handle({ method, path, query, sid, body });
 */
(function (root) {
    "use strict";

    // =====================================================================
    // errors & Java-compatible helpers
    // =====================================================================

    /** Carries an explicit HTTP status (grocery.web.ApiException). */
    class ApiError extends Error {
        constructor(status, message) { super(message); this.status = status; }
    }
    /** IllegalArgumentException / IllegalStateException - both map to HTTP 400. */
    class BadRequest extends Error {}
    const bad = msg => new BadRequest(msg);
    const forbidden = msg => new ApiError(403, msg);
    const notFound = msg => new ApiError(404, msg);

    /** String.trim(): strips chars <= U+0020 only (not all Unicode whitespace like JS trim). */
    function jtrim(s) {
        let a = 0, b = s.length;
        while (a < b && s.charCodeAt(a) <= 32) a++;
        while (b > a && s.charCodeAt(b - 1) <= 32) b--;
        return s.slice(a, b);
    }
    /** grocery.util.Text.oneLine */
    function oneLine(s) {
        if (s == null) return "";
        return jtrim(String(s).split("\r\n").join(" ").replace(/[\r\n]/g, " "));
    }
    function eqIC(a, b) {
        if (a == null || b == null) return false;
        return a.length === b.length && (a === b || a.toUpperCase() === b.toUpperCase() || a.toLowerCase() === b.toLowerCase());
    }
    /** Java Double.toString */
    function jd(d) {
        if (Number.isNaN(d)) return "NaN";
        if (d === Infinity) return "Infinity";
        if (d === -Infinity) return "-Infinity";
        if (d === 0) return Object.is(d, -0) ? "-0.0" : "0.0";
        const a = Math.abs(d);
        if (a >= 1e-3 && a < 1e7) {
            const s = String(d);
            return s.includes(".") ? s : s + ".0";
        }
        let [m, e] = d.toExponential().split("e");
        if (!m.includes(".")) m += ".0";
        return m + "E" + (e[0] === "+" ? e.slice(1) : e);
    }
    /** The services' private trim(double): whole numbers without ".0". */
    function trimNum(d) {
        if (d === Math.floor(d)) return String(Math.trunc(d));
        return jd(d);
    }
    /** Double.compare: also orders -0.0 before 0.0 and NaN last, which plain subtraction doesn't. */
    function dcmp(a, b) {
        if (a < b) return -1;
        if (a > b) return 1;
        const ka = Number.isNaN(a) ? 2 : Object.is(a, -0) ? -1 : 0;
        const kb = Number.isNaN(b) ? 2 : Object.is(b, -0) ? -1 : 0;
        return ka - kb;
    }
    /** ApiHandler.round2 - Math.round semantics (floor(x + 0.5)) match Java's. */
    const round2 = v => Math.round(v * 100.0) / 100.0;

    function parseIntOr(s, fallback) {
        if (s == null || s === "") return fallback;
        const t = jtrim(String(s));
        if (!/^[+-]?\d+$/.test(t)) return fallback;
        const n = Number(t);
        if (n > 2147483647 || n < -2147483648) return fallback;
        return n;
    }

    // Gson-style coercion of request DTO fields.
    const str = v => (v == null ? null : (typeof v === "string" ? v : String(v)));
    function dbl(v) {                      // primitive double: missing -> 0
        if (v == null) return 0;
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isNaN(n) && !(typeof v === "number")) throw new Error("Expected a number but was " + JSON.stringify(v));
        return n;
    }
    const boxed = v => (v == null ? null : dbl(v));   // Double: missing -> null
    const bool = v => v === true || v === "true";

    // =====================================================================
    // money: integer paise with BigDecimal HALF_UP rounding
    // =====================================================================

    const TEN = 10n;
    const pow10 = n => TEN ** BigInt(n);

    /** Parse a decimal string into {m: BigInt mantissa, s: scale}, or null if invalid. */
    function dec(text) {
        const t = String(text);
        const r = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
        if (!r || ((r[2] || "") + (r[3] || "")) === "") return null;
        const frac = r[3] || "";
        let m = BigInt((r[2] || "0") + frac);
        if (r[1] === "-") m = -m;
        let s = frac.length - (r[4] ? parseInt(r[4], 10) : 0);
        if (s < 0) { m *= pow10(-s); s = 0; }
        return { m, s };
    }
    /** BigDecimal.valueOf(double): the double's shortest decimal representation. */
    function decOfDouble(d) {
        if (!Number.isFinite(d)) throw bad("Invalid number: " + d);
        return dec(String(d));
    }
    /** Integer division rounding HALF_UP (ties away from zero). d > 0. */
    function halfUpDiv(n, d) {
        let q = n / d;
        const r = n % d;
        const ar = r < 0n ? -r : r;
        if (ar * 2n >= d) q += (n < 0n ? -1n : 1n);
        return q;
    }
    function toScale2(m, s) {
        return s <= 2 ? m * pow10(2 - s) : halfUpDiv(m, pow10(s - 2));
    }
    const M = {
        ZERO: 0,
        /** Money.of(double) */
        of(d) { const x = decOfDouble(d); return Number(toScale2(x.m, x.s)); },
        /** Money.parse(text): blank/invalid -> 0 */
        parse(text) {
            if (text == null) return 0;
            const cleaned = jtrim(String(text)).split(",").join("");
            if (cleaned === "") return 0;
            const x = dec(cleaned);
            return x ? Number(toScale2(x.m, x.s)) : 0;
        },
        /** Money.format: plain string, exactly 2 decimals */
        fmt(p) {
            const neg = p < 0;
            const a = Math.abs(p);
            const s = String(Math.floor(a / 100)) + "." + String(a % 100).padStart(2, "0");
            return neg ? "-" + s : s;
        },
        /** BigDecimal.doubleValue() */
        num(p) { return p / 100; },
        /** scale(paise * BigDecimal.valueOf(qty)) - CartLine.getAmount / refund line amount */
        times(paise, qty) {
            const q = decOfDouble(qty);
            return Number(halfUpDiv(BigInt(paise) * q.m, pow10(q.s)));
        },
        /** scale(amount * BigDecimal.valueOf(ratePercent) / 100) - CartLine.getTax */
        taxOf(amountPaise, ratePercent) {
            const r = decOfDouble(ratePercent);
            return Number(halfUpDiv(BigInt(amountPaise) * r.m, pow10(r.s) * 100n));
        },
        /** scale(x / 2) - Invoice.getCgst */
        half(p) { return Number(halfUpDiv(BigInt(p), 2n)); },
        /** setScale(0, HALF_UP) then back to paise - Invoice grand total */
        toRupee(p) { return Number(halfUpDiv(BigInt(p), 100n)) * 100; },
    };

    // =====================================================================
    // wall clock pinned to the store's timezone (grocery.util.Time)
    // =====================================================================

    class Clock {
        constructor(nowMs) {
            this.nowMs = nowMs;
            this.seq = 0;
            this.setZone("Asia/Kolkata");
        }
        setZone(tz) {
            try {
                this.fmt = new Intl.DateTimeFormat("en-GB", {
                    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
                    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
                });
                this.zone = tz;
                return true;
            } catch (e) {
                return false;
            }
        }
        /** LocalDateTime.now(zone): {s: "yyyy-MM-ddTHH:mm:ss", f: sub-second order}. */
        now() {
            const parts = {};
            for (const p of this.fmt.formatToParts(new Date(this.nowMs()))) parts[p.type] = p.value;
            const hour = parts.hour === "24" ? "00" : parts.hour;
            // f orders same-second timestamps created in this run (Java keeps nanoseconds in memory).
            return { s: `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`, f: ++this.seq };
        }
        today() { return this.now().s.slice(0, 10); }
    }
    const cmpDt = (a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.f - b.f);
    const stampOf = dt => dt.s;
    /** LocalDateTime.parse(s, "yyyy-MM-dd'T'HH:mm:ss") or null */
    function parseStamp(s) {
        if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return null;
        if (!validDate(s.slice(0, 10))) return null;
        const h = +s.slice(11, 13), mi = +s.slice(14, 16), se = +s.slice(17, 19);
        if (h > 23 || mi > 59 || se > 59) return null;
        return { s, f: 0 };
    }
    function validDate(d) {
        const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!r) return false;
        const y = +r[1], m = +r[2], day = +r[3];
        if (m < 1 || m > 12 || day < 1) return false;
        const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return day <= dim;
    }
    /** ApiHandler.parseDate: LocalDate.parse or null */
    function parseDate(s) {
        if (s == null || jtrim(String(s)) === "") return null;
        const t = jtrim(String(s));
        return validDate(t) ? t : null;
    }
    function addDays(d, n) {
        const [y, m, day] = d.split("-").map(Number);
        const x = new Date(Date.UTC(y, m - 1, day + n));
        return x.toISOString().slice(0, 10);
    }
    function daysBetween(a, b) {
        const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
        return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
    }
    /** Mappers.DATE_FMT "dd-MM-yyyy HH:mm" */
    const fmtDate = dt => `${dt.s.slice(8, 10)}-${dt.s.slice(5, 7)}-${dt.s.slice(0, 4)} ${dt.s.slice(11, 16)}`;
    /** Mappers.AUDIT_DATE_FMT "dd-MM-yyyy HH:mm:ss" */
    const fmtAudit = dt => `${dt.s.slice(8, 10)}-${dt.s.slice(5, 7)}-${dt.s.slice(0, 4)} ${dt.s.slice(11, 19)}`;

    // =====================================================================
    // Db - sql.js wrapper with the same nest-aware transactions as grocery.util.Db
    // =====================================================================

    class Db {
        constructor(sqlDb) {
            this.sql = sqlDb;
            this.depth = 0;
            this.after = [];
            this.dirty = false;
            this.sql.exec("PRAGMA foreign_keys=ON");
            createSchema(this);
        }
        query(sql, params) {
            const st = this.sql.prepare(sql);
            try {
                if (params) st.bind(params);
                const out = [];
                while (st.step()) out.push(st.getAsObject());
                return out;
            } finally {
                st.free();
            }
        }
        update(sql, params) {
            this.sql.run(sql, params || []);
            this.dirty = true;
            return this.sql.getRowsModified();
        }
        exec(sql) {
            this.sql.exec(sql);
            this.dirty = true;
        }
        inTransaction(body) {
            if (this.depth > 0) {
                this.depth++;
                try { return body(); } finally { this.depth--; }
            }
            let committed = false;
            this.sql.exec("BEGIN");
            this.depth = 1;
            try {
                const r = body();
                this.sql.exec("COMMIT");
                committed = true;
                this.dirty = true;
                return r;
            } catch (e) {
                try { this.sql.exec("ROLLBACK"); } catch (ignore) { /* already rolled back */ }
                throw e;
            } finally {
                this.depth = 0;
                const pending = this.after;
                this.after = [];
                if (committed) for (const fn of pending) fn();
            }
        }
        afterCommit(fn) {
            if (this.depth === 0) fn(); else this.after.push(fn);
        }
        /** A consistent snapshot of the whole database file. */
        export() {
            const bytes = this.sql.export();
            this.sql.exec("PRAGMA foreign_keys=ON"); // export() reopens the db, resetting pragmas
            return bytes;
        }
    }

    function createSchema(db) {
        const s = db.sql;
        s.exec("CREATE TABLE IF NOT EXISTS branches (" +
            "id TEXT PRIMARY KEY, name TEXT NOT NULL, addressLine1 TEXT NOT NULL DEFAULT '', " +
            "addressLine2 TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', gstin TEXT NOT NULL DEFAULT '', " +
            "stateCode TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1)");
        addColumnIfMissing(s, "branches", "stateCode", "TEXT NOT NULL DEFAULT ''");
        s.exec("CREATE TABLE IF NOT EXISTS items (" +
            "id TEXT PRIMARY KEY, branchId TEXT NOT NULL REFERENCES branches(id), name TEXT NOT NULL, " +
            "category TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '', price TEXT NOT NULL, " +
            "taxRatePercent REAL NOT NULL DEFAULT 0, stock REAL NOT NULL DEFAULT 0, barcode TEXT NOT NULL DEFAULT '', " +
            "reorderLevel REAL NOT NULL DEFAULT 0, costPrice TEXT NOT NULL DEFAULT '0.00')");
        s.exec("CREATE INDEX IF NOT EXISTS idx_items_branchId ON items(branchId)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_items_branch_barcode ON items(branchId, barcode)");
        addColumnIfMissing(s, "items", "costPrice", "TEXT NOT NULL DEFAULT '0.00'");
        s.exec("CREATE TABLE IF NOT EXISTS users (" +
            "username TEXT PRIMARY KEY, passwordHash TEXT NOT NULL, fullName TEXT NOT NULL, role TEXT NOT NULL, " +
            "branchId TEXT REFERENCES branches(id), active INTEGER NOT NULL DEFAULT 1, " +
            "mustChangePassword INTEGER NOT NULL DEFAULT 0)");
        s.exec("CREATE TABLE IF NOT EXISTS invoices (" +
            "invoiceNo TEXT PRIMARY KEY, branchId TEXT NOT NULL REFERENCES branches(id), cashierUsername TEXT NOT NULL, " +
            "dateTime TEXT NOT NULL, customerName TEXT NOT NULL DEFAULT '', customerPhone TEXT NOT NULL DEFAULT '', " +
            "paymentMode TEXT NOT NULL DEFAULT '', subTotal TEXT NOT NULL, discount TEXT NOT NULL, totalTax TEXT NOT NULL, " +
            "grandTotal TEXT NOT NULL, amountPaid TEXT NOT NULL, placeOfSupplyStateCode TEXT NOT NULL DEFAULT '')");
        addColumnIfMissing(s, "invoices", "placeOfSupplyStateCode", "TEXT NOT NULL DEFAULT ''");
        s.exec("CREATE INDEX IF NOT EXISTS idx_invoices_branchId ON invoices(branchId)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_invoices_dateTime ON invoices(dateTime)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_invoices_cashier ON invoices(cashierUsername)");
        s.exec("CREATE TABLE IF NOT EXISTS invoice_lines (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, invoiceNo TEXT NOT NULL REFERENCES invoices(invoiceNo) ON DELETE CASCADE, " +
            "itemId TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, price TEXT NOT NULL, " +
            "taxRatePercent REAL NOT NULL, quantity REAL NOT NULL, amount TEXT NOT NULL, tax TEXT NOT NULL)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoiceNo ON invoice_lines(invoiceNo)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_invoice_lines_itemId ON invoice_lines(itemId)");
        s.exec("CREATE TABLE IF NOT EXISTS refunds (" +
            "refundNo TEXT PRIMARY KEY, originalInvoiceNo TEXT NOT NULL REFERENCES invoices(invoiceNo), " +
            "branchId TEXT NOT NULL REFERENCES branches(id), cashierUsername TEXT NOT NULL, dateTime TEXT NOT NULL, " +
            "refundAmount TEXT NOT NULL, refundTax TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')");
        s.exec("CREATE INDEX IF NOT EXISTS idx_refunds_originalInvoiceNo ON refunds(originalInvoiceNo)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_refunds_branchId ON refunds(branchId)");
        s.exec("CREATE TABLE IF NOT EXISTS refund_lines (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, refundNo TEXT NOT NULL REFERENCES refunds(refundNo) ON DELETE CASCADE, " +
            "itemId TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, price TEXT NOT NULL, " +
            "taxRatePercent REAL NOT NULL, quantity REAL NOT NULL, amount TEXT NOT NULL, tax TEXT NOT NULL)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_refund_lines_refundNo ON refund_lines(refundNo)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_refund_lines_itemId ON refund_lines(itemId)");
        s.exec("CREATE INDEX IF NOT EXISTS idx_refunds_dateTime ON refunds(dateTime)");
        s.exec("CREATE TABLE IF NOT EXISTS audit_log (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, \"when\" TEXT NOT NULL, username TEXT NOT NULL, role TEXT, " +
            "branchId TEXT, action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '')");
        s.exec("CREATE INDEX IF NOT EXISTS idx_audit_log_when ON audit_log(\"when\")");
    }
    function addColumnIfMissing(s, table, column, ddl) {
        try {
            s.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + ddl);
        } catch (e) {
            if (!String(e.message || "").toLowerCase().includes("duplicate column name")) throw e;
        }
    }

    // =====================================================================
    // models
    // =====================================================================

    /** grocery.model.Invoice - totals are derived from the lines exactly as the Java constructor does. */
    function makeInvoice(invoiceNo, branchId, cashier, dateTime, customerName, customerPhone, paymentMode,
                         lines, discount, amountPaid, posState, branchState) {
        const pos = posState == null ? "" : posState;
        const bs = branchState == null ? "" : branchState;
        const interState = pos !== "" && bs !== "" && !eqIC(pos, bs);
        let sub = 0, tax = 0;
        for (const l of lines) { sub += l.amount; tax += l.tax; }
        const net = sub - discount + tax;
        const grand = M.toRupee(net);
        const paid = (amountPaid == null || amountPaid < grand) ? grand : amountPaid;
        const cgst = interState ? 0 : M.half(tax);
        return {
            invoiceNo, branchId, cashierUsername: cashier, dateTime, customerName, customerPhone, paymentMode,
            lines: lines.slice(), subTotal: sub, discount, totalTax: tax, netAmount: net, roundOff: grand - net,
            grandTotal: grand, amountPaid: paid, placeOfSupplyStateCode: pos, branchStateCode: bs, interState,
            cgst, sgst: interState ? 0 : tax - cgst, igst: interState ? tax : 0, changeDue: paid - grand,
        };
    }
    function makeLine(itemId, name, unit, price, taxRatePercent, quantity, amount, tax) {
        return { itemId, name, unit, price, taxRatePercent, quantity, amount, tax };
    }
    function makeRefund(refundNo, originalInvoiceNo, branchId, cashier, dateTime, lines, reason) {
        let amt = 0, tax = 0;
        for (const l of lines) { amt += l.amount + l.tax; tax += l.tax; }
        return {
            refundNo, originalInvoiceNo, branchId, cashierUsername: cashier, dateTime, lines: lines.slice(),
            reason: reason == null ? "" : reason, refundAmount: amt, refundTax: tax,
        };
    }
    const ROLES = ["ADMIN", "MANAGER", "CASHIER"];
    function parseRole(s) {
        if (s == null) return "CASHIER";
        const r = jtrim(String(s)).toUpperCase();
        return ROLES.includes(r) ? r : "CASHIER";
    }
    const canAccessBranch = (u, other) => u.role === "ADMIN" || eqIC(u.branchId, other);

    // =====================================================================
    // services
    // =====================================================================

    const DEFAULT_STORE = [
        ["name", "FreshMart Grocery Store"],
        ["addressLine1", "No. 12, Market Road, T. Nagar"],
        ["addressLine2", "Chennai - 600017, Tamil Nadu"],
        ["phone", "+91 98765 43210"],
        ["email", "billing@freshmart.example"],
        ["gstin", "33ABCDE1234F1Z5"],
        ["currency", "Rs."],
        ["timezone", "Asia/Kolkata"],
    ];

    /** grocery.config.StoreConfig - backed by store.properties text instead of a file. */
    class StoreConfig {
        constructor(propsText, Props) {
            this.Props = Props;
            this.values = new Map(DEFAULT_STORE);
            this.dirty = false;
            if (propsText == null) {
                this.dirty = true; // Java writes the defaults out on first run
            } else {
                for (const [k, v] of Props.parse(propsText)) if (this.values.has(k)) this.values.set(k, v);
            }
        }
        get(k) { return this.values.get(k); }
        set(k, v) { this.values.set(k, v); this.dirty = true; }
        text() { return this.Props.serialize(this.values, "Grocery store details shown on invoices"); }
    }

    class BranchService {
        constructor(db, store) {
            this.db = db;
            this.list = db.query("SELECT * FROM branches").map(r => ({
                id: r.id, name: r.name, addressLine1: r.addressLine1, addressLine2: r.addressLine2, phone: r.phone,
                gstin: r.gstin, stateCode: r.stateCode == null ? "" : r.stateCode, active: r.active !== 0,
            }));
            if (!this.list.length) {
                const b = {
                    id: "BR-001", name: store.get("name"), addressLine1: store.get("addressLine1"),
                    addressLine2: store.get("addressLine2"), phone: store.get("phone"), gstin: store.get("gstin"),
                    stateCode: "", active: true,
                };
                this.list.push(b);
                this.insert(b);
            }
        }
        getAll() { return this.list.slice(); }
        findById(id) { return id == null ? null : (this.list.find(b => eqIC(b.id, id)) || null); }
        require(id) {
            const b = this.findById(id);
            if (!b) throw bad("Unknown branch: " + id);
            return b;
        }
        defaultBranchId() { return this.list[0].id; }
        add(b) {
            if (b.id == null || b.id === "") b.id = this.nextId();
            if (this.findById(b.id)) throw bad("A branch with id '" + b.id + "' already exists.");
            this.list.push(b);
            this.insert(b);
        }
        update(b) {
            const i = this.list.findIndex(x => eqIC(x.id, b.id));
            if (i < 0) throw bad("No branch with id '" + b.id + "'.");
            this.list[i] = b;
            this.db.update("UPDATE branches SET name=?, addressLine1=?, addressLine2=?, phone=?, gstin=?, stateCode=?, active=? WHERE id=?",
                [b.name, b.addressLine1, b.addressLine2, b.phone, b.gstin, b.stateCode, b.active ? 1 : 0, b.id]);
        }
        nextId() { return "BR-" + String(maxSuffix(this.list.map(b => b.id), 0) + 1).padStart(3, "0"); }
        insert(b) {
            this.db.update("INSERT INTO branches(id, name, addressLine1, addressLine2, phone, gstin, stateCode, active) VALUES(?,?,?,?,?,?,?,?)",
                [b.id, b.name, b.addressLine1, b.addressLine2, b.phone, b.gstin, b.stateCode, b.active ? 1 : 0]);
        }
    }

    /** Highest numeric suffix after the last '-' (the id/number allocators all use this). */
    function maxSuffix(ids, start) {
        let max = start;
        for (const id of ids) {
            const dash = id.lastIndexOf("-");
            if (dash < 0) continue;
            const tail = id.slice(dash + 1);
            if (/^[+-]?\d+$/.test(tail)) {
                const n = Number(tail);
                if (n <= 2147483647 && n >= -2147483648) max = Math.max(max, n);
            }
        }
        return max;
    }

    const SEED = [
        ["ITM-001", "Basmati Rice 1kg", "Grains", "pkt", 120.00, 5, 60, "8901000000017"],
        ["ITM-002", "Toor Dal 1kg", "Pulses", "pkt", 145.00, 5, 40, "8901000000024"],
        ["ITM-003", "Sunflower Oil 1L", "Oils", "ltr", 165.00, 5, 35, "8901000000031"],
        ["ITM-004", "Aashirvaad Atta 5kg", "Grains", "pkt", 285.00, 5, 25, "8901000000048"],
        ["ITM-005", "Sugar 1kg", "Essentials", "kg", 48.00, 5, 80, "8901000000055"],
        ["ITM-006", "Iodised Salt 1kg", "Essentials", "pkt", 22.00, 5, 90, "8901000000062"],
        ["ITM-007", "Amul Butter 100g", "Dairy", "pc", 58.00, 12, 30, "8901000000079"],
        ["ITM-008", "Milk 500ml", "Dairy", "pkt", 28.00, 0, 50, "8901000000086"],
        ["ITM-009", "Brown Eggs (6)", "Dairy", "pkt", 72.00, 0, 40, "8901000000093"],
        ["ITM-010", "Tata Tea Gold 250g", "Beverages", "pkt", 140.00, 5, 28, "8901000000109"],
        ["ITM-011", "Nescafe Coffee 50g", "Beverages", "pc", 165.00, 18, 22, "8901000000116"],
        ["ITM-012", "Maggi Noodles (4 pack)", "Snacks", "pkt", 56.00, 12, 45, "8901000000123"],
        ["ITM-013", "Britannia Biscuits", "Snacks", "pkt", 30.00, 18, 60, "8901000000130"],
        ["ITM-014", "Lays Chips", "Snacks", "pc", 20.00, 18, 70, "8901000000147"],
        ["ITM-015", "Colgate Toothpaste 100g", "Personal Care", "pc", 92.00, 18, 33, "8901000000154"],
        ["ITM-016", "Lifebuoy Soap", "Personal Care", "pc", 35.00, 18, 50, "8901000000161"],
        ["ITM-017", "Surf Excel 1kg", "Household", "pkt", 130.00, 18, 27, "8901000000178"],
        ["ITM-018", "Vim Dishwash Bar", "Household", "pc", 20.00, 18, 55, "8901000000185"],
        ["ITM-019", "Onion 1kg", "Vegetables", "kg", 40.00, 0, 100, "8901000000192"],
        ["ITM-020", "Tomato 1kg", "Vegetables", "kg", 35.00, 0, 100, "8901000000208"],
        ["ITM-021", "Potato 1kg", "Vegetables", "kg", 32.00, 0, 100, "8901000000215"],
        ["ITM-022", "Banana 1dozen", "Fruits", "dozen", 60.00, 0, 40, "8901000000222"],
        ["ITM-023", "Apple 1kg", "Fruits", "kg", 180.00, 0, 30, "8901000000239"],
        ["ITM-024", "Whole Wheat Bread 400g", "Bakery", "pkt", 45.00, 5, 30, "8901000000246"],
        ["ITM-025", "Milk Bread 400g", "Bakery", "pkt", 40.00, 5, 25, "8901000000253"],
        ["ITM-026", "Rusk 200g", "Bakery", "pkt", 35.00, 12, 40, "8901000000260"],
        ["ITM-027", "Frozen Green Peas 500g", "Frozen Foods", "pkt", 90.00, 5, 20, "8901000000277"],
        ["ITM-028", "Frozen Paratha (5pc)", "Frozen Foods", "pkt", 120.00, 12, 18, "8901000000284"],
        ["ITM-029", "Ice Cream Tub 700ml", "Frozen Foods", "pc", 180.00, 18, 15, "8901000000291"],
        ["ITM-030", "Harpic Toilet Cleaner 500ml", "Household", "pc", 95.00, 18, 25, "8901000000307"],
        ["ITM-031", "Colin Glass Cleaner 500ml", "Household", "pc", 85.00, 18, 20, "8901000000314"],
        ["ITM-032", "Mr. Clean Floor Cleaner 1L", "Household", "pc", 150.00, 18, 18, "8901000000321"],
        ["ITM-033", "Garbage Bags (30pc)", "Household", "pkt", 110.00, 18, 30, "8901000000338"],
        ["ITM-034", "Candles (Pack of 6)", "Household", "pkt", 60.00, 12, 25, "8901000000482"],
        ["ITM-035", "Head & Shoulders Shampoo 180ml", "Personal Care", "pc", 210.00, 18, 22, "8901000000345"],
        ["ITM-036", "Dove Soap", "Personal Care", "pc", 55.00, 18, 45, "8901000000352"],
        ["ITM-037", "Parachute Coconut Oil 200ml", "Personal Care", "pc", 130.00, 18, 28, "8901000000369"],
        ["ITM-038", "Pampers Diapers (M, 20pc)", "Baby Care", "pkt", 450.00, 12, 15, "8901000000376"],
        ["ITM-039", "Johnson's Baby Powder 200g", "Baby Care", "pc", 180.00, 18, 20, "8901000000383"],
        ["ITM-040", "Cerelac Baby Food 300g", "Baby Care", "pc", 260.00, 5, 18, "8901000000390"],
        ["ITM-041", "Dairy Milk Chocolate 55g", "Snacks", "pc", 50.00, 18, 60, "8901000000406"],
        ["ITM-042", "Kurkure 90g", "Snacks", "pkt", 20.00, 18, 70, "8901000000413"],
        ["ITM-043", "Haldiram's Namkeen 200g", "Snacks", "pkt", 75.00, 12, 40, "8901000000420"],
        ["ITM-044", "Real Fruit Juice 1L", "Beverages", "pkt", 120.00, 12, 25, "8901000000437"],
        ["ITM-045", "Coca-Cola 750ml", "Beverages", "pc", 45.00, 28, 48, "8901000000444"],
        ["ITM-046", "Bisleri Water 1L", "Beverages", "pc", 20.00, 18, 90, "8901000000451"],
        ["ITM-047", "A4 Notebook", "Stationery", "pc", 60.00, 12, 35, "8901000000468"],
        ["ITM-048", "Ball Pen (Pack of 5)", "Stationery", "pkt", 40.00, 12, 50, "8901000000475"],
    ];
    const DEFAULT_REORDER_LEVEL = 10;

    class InventoryService {
        constructor(db, defaultBranchId) {
            this.db = db;
            this.items = db.query("SELECT * FROM items").map(r => ({
                id: r.id, branchId: r.branchId, name: r.name, category: r.category, unit: r.unit,
                price: M.parse(r.price), costPrice: M.parse(r.costPrice), taxRatePercent: r.taxRatePercent,
                stock: r.stock, barcode: r.barcode == null ? "" : r.barcode, reorderLevel: r.reorderLevel,
            }));
            if (!this.items.length) {
                const fresh = SEED.map(([id, name, category, unit, price, tax, stock, barcode]) => ({
                    id, branchId: defaultBranchId, name, category, unit, price: M.of(price), costPrice: 0,
                    taxRatePercent: tax, stock, barcode, reorderLevel: DEFAULT_REORDER_LEVEL,
                }));
                this.items.push(...fresh);
                db.inTransaction(() => { for (const it of fresh) this.insert(it); });
            }
        }
        getAll(branchId) { return this.items.filter(it => eqIC(it.branchId, branchId)); }
        findById(id) { return id == null ? null : (this.items.find(it => eqIC(it.id, id)) || null); }
        findInBranch(branchId, id) {
            const it = this.findById(id);
            return it && eqIC(it.branchId, branchId) ? it : null;
        }
        findByBarcode(branchId, barcode) {
            if (barcode == null || jtrim(barcode) === "") return null;
            const b = jtrim(barcode);
            return this.items.find(it => eqIC(it.branchId, branchId) && eqIC(it.barcode, b)) || null;
        }
        search(branchId, query) {
            const scoped = this.getAll(branchId);
            if (query == null || jtrim(query) === "") return scoped;
            const q = jtrim(query).toLowerCase();
            return scoped.filter(it => it.id.toLowerCase().includes(q) || it.name.toLowerCase().includes(q)
                || it.category.toLowerCase().includes(q));
        }
        add(item) {
            this.db.inTransaction(() => {
                if (item.id == null || item.id === "") item.id = this.nextId();
                if (this.findById(item.id)) throw bad("An item with id '" + item.id + "' already exists.");
                this.insert(item);
                this.db.afterCommit(() => this.items.push(item));
            });
        }
        update(branchId, item) {
            this.db.inTransaction(() => {
                const existing = this.findById(item.id);
                if (!existing) throw bad("No item with id '" + item.id + "'.");
                if (!eqIC(existing.branchId, branchId)) throw bad("That item does not belong to this branch.");
                item.stock = existing.stock;
                this.db.update("UPDATE items SET branchId=?, name=?, category=?, unit=?, price=?, taxRatePercent=?, " +
                    "barcode=?, reorderLevel=?, costPrice=? WHERE id=?",
                    [item.branchId, item.name, item.category, item.unit, M.fmt(item.price), item.taxRatePercent,
                        item.barcode, item.reorderLevel, M.fmt(item.costPrice), item.id]);
                this.db.afterCommit(() => {
                    const i = this.items.findIndex(x => eqIC(x.id, item.id));
                    if (i >= 0) this.items[i] = item;
                });
            });
        }
        adjustStock(branchId, itemId, delta) {
            if (delta === 0) return;
            this.db.inTransaction(() => {
                const item = this.findInBranch(branchId, itemId);
                if (!item) throw bad("No item with id '" + itemId + "' in this branch.");
                const newStock = item.stock + delta;
                if (newStock < 0) {
                    throw bad("Cannot reduce stock below zero (current " + trimNum(item.stock)
                        + ", requested change " + trimNum(delta) + ").");
                }
                this.writeStock(itemId, newStock);
                this.db.afterCommit(() => { item.stock = newStock; });
            });
        }
        delete(branchId, id) {
            this.db.inTransaction(() => {
                const target = this.items.find(it => eqIC(it.id, id) && eqIC(it.branchId, branchId));
                if (!target) return;
                this.db.update("DELETE FROM items WHERE id=? AND branchId=?", [id, branchId]);
                this.db.afterCommit(() => {
                    const i = this.items.indexOf(target);
                    if (i >= 0) this.items.splice(i, 1);
                });
            });
        }
        reserveStock(branchId, requests) {
            const total = new Map();
            for (const r of requests) {
                if (r.quantity <= 0) throw bad("Quantity must be greater than zero.");
                total.set(r.itemId, (total.get(r.itemId) || 0) + r.quantity);
            }
            const resolved = new Map();
            const newStock = new Map();
            for (const [id, qty] of total) {
                const item = this.findInBranch(branchId, id);
                if (!item) throw bad("Unknown item: " + id);
                if (qty > item.stock) {
                    throw bad("Not enough stock for '" + item.name + "'. Available: " + trimNum(item.stock)
                        + ", requested: " + trimNum(qty) + ".");
                }
                resolved.set(id, item);
                newStock.set(id, item.stock - qty);
            }
            this.db.inTransaction(() => {
                for (const [id, item] of resolved) this.writeStock(item.id, newStock.get(id));
                this.db.afterCommit(() => { for (const [id, item] of resolved) item.stock = newStock.get(id); });
            });
            return resolved;
        }
        restoreStock(branchId, requests) {
            const totals = new Map();
            for (const r of requests) {
                if (r.quantity <= 0) continue;
                totals.set(r.itemId, (totals.get(r.itemId) || 0) + r.quantity);
            }
            const newStock = new Map();
            for (const [id, qty] of totals) {
                const item = this.findInBranch(branchId, id);
                if (!item) continue;
                newStock.set(item, item.stock + qty);
            }
            if (!newStock.size) return;
            this.db.inTransaction(() => {
                for (const [item, s] of newStock) this.writeStock(item.id, s);
                this.db.afterCommit(() => { for (const [item, s] of newStock) item.stock = s; });
            });
        }
        cloneCatalogue(fromBranchId, toBranchId) {
            const created = [];
            this.db.inTransaction(() => {
                let seq = maxSuffix(this.items.map(it => it.id), 0) + 1;
                for (const src of this.getAll(fromBranchId)) {
                    const copy = {
                        id: "ITM-" + String(seq++).padStart(3, "0"), branchId: toBranchId, name: src.name,
                        category: src.category, unit: src.unit, price: src.price, costPrice: src.costPrice,
                        taxRatePercent: src.taxRatePercent, stock: 0, barcode: src.barcode, reorderLevel: src.reorderLevel,
                    };
                    created.push(copy);
                    this.insert(copy);
                }
                this.db.afterCommit(() => this.items.push(...created));
            });
            return created;
        }
        nextId() { return "ITM-" + String(maxSuffix(this.items.map(it => it.id), 0) + 1).padStart(3, "0"); }
        insert(it) {
            this.db.update("INSERT INTO items(id, branchId, name, category, unit, price, taxRatePercent, stock, barcode, " +
                "reorderLevel, costPrice) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                [it.id, it.branchId, it.name, it.category, it.unit, M.fmt(it.price), it.taxRatePercent, it.stock,
                    it.barcode, it.reorderLevel, M.fmt(it.costPrice)]);
        }
        writeStock(itemId, stock) { this.db.update("UPDATE items SET stock=? WHERE id=?", [stock, itemId]); }
    }

    function linesFromRows(rows, key) {
        const by = new Map();
        for (const r of rows) {
            if (!by.has(r[key])) by.set(r[key], []);
            by.get(r[key]).push(makeLine(r.itemId, r.name, r.unit, M.parse(r.price), r.taxRatePercent, r.quantity,
                M.parse(r.amount), M.parse(r.tax)));
        }
        return by;
    }
    const newestFirst = list => list.sort((a, b) => cmpDt(b.dateTime, a.dateTime));

    class InvoiceStore {
        constructor(db, branches, clock) {
            this.db = db;
            this.clock = clock;
            const lines = linesFromRows(db.query("SELECT * FROM invoice_lines"), "invoiceNo");
            this.invoices = db.query("SELECT * FROM invoices").map(r => {
                const b = branches.findById(r.branchId);
                return makeInvoice(r.invoiceNo, r.branchId, r.cashierUsername, parseStamp(r.dateTime) || clock.now(),
                    r.customerName, r.customerPhone, r.paymentMode, lines.get(r.invoiceNo) || [],
                    M.parse(r.discount), M.parse(r.amountPaid), r.placeOfSupplyStateCode == null ? "" : r.placeOfSupplyStateCode,
                    b ? b.stateCode : "");
            });
        }
        getAll() { return newestFirst(this.invoices.slice()); }
        getAllForBranch(branchId) { return newestFirst(this.invoices.filter(i => eqIC(i.branchId, branchId))); }
        findByNo(no) { return this.invoices.find(i => eqIC(i.invoiceNo, no)) || null; }
        createAndSave(branchId, cashier, name, phone, mode, lines, discount, amountPaid, pos, branchState) {
            const inv = makeInvoice("INV-" + (maxSuffix(this.invoices.map(i => i.invoiceNo), 1000) + 1), branchId, cashier,
                this.clock.now(), name, phone, mode, lines, discount, amountPaid, pos, branchState);
            this.db.inTransaction(() => {
                this.db.update("INSERT INTO invoices(invoiceNo, branchId, cashierUsername, dateTime, customerName, customerPhone, " +
                    "paymentMode, subTotal, discount, totalTax, grandTotal, amountPaid, placeOfSupplyStateCode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [inv.invoiceNo, inv.branchId, inv.cashierUsername, stampOf(inv.dateTime), inv.customerName, inv.customerPhone,
                        inv.paymentMode, M.fmt(inv.subTotal), M.fmt(inv.discount), M.fmt(inv.totalTax), M.fmt(inv.grandTotal),
                        M.fmt(inv.amountPaid), inv.placeOfSupplyStateCode]);
                for (const l of inv.lines) insertLine(this.db, "invoice_lines", "invoiceNo", inv.invoiceNo, l);
            });
            this.invoices.push(inv);
            return inv;
        }
    }
    function insertLine(db, table, keyCol, key, l) {
        db.update("INSERT INTO " + table + "(" + keyCol + ", itemId, name, unit, price, taxRatePercent, quantity, amount, tax) " +
            "VALUES(?,?,?,?,?,?,?,?,?)",
            [key, l.itemId, l.name, l.unit, M.fmt(l.price), l.taxRatePercent, l.quantity, M.fmt(l.amount), M.fmt(l.tax)]);
    }

    /** RefundService.mergeLines / the refundable view's duplicate-item collapse. */
    function mergeLines(lines) {
        const merged = new Map();
        for (const l of lines) {
            const a = merged.get(l.itemId);
            merged.set(l.itemId, a ? makeLine(a.itemId, a.name, a.unit, a.price, a.taxRatePercent,
                a.quantity + l.quantity, a.amount + l.amount, a.tax + l.tax) : l);
        }
        return merged;
    }

    class RefundService {
        constructor(db, clock) {
            this.db = db;
            this.clock = clock;
            const lines = linesFromRows(db.query("SELECT * FROM refund_lines"), "refundNo");
            this.refunds = db.query("SELECT * FROM refunds").map(r => makeRefund(r.refundNo, r.originalInvoiceNo, r.branchId,
                r.cashierUsername, parseStamp(r.dateTime) || clock.now(), lines.get(r.refundNo) || [], r.reason));
        }
        getAll() { return newestFirst(this.refunds.slice()); }
        getAllForBranch(branchId) { return newestFirst(this.refunds.filter(r => eqIC(r.branchId, branchId))); }
        findByNo(no) { return this.refunds.find(r => eqIC(r.refundNo, no)) || null; }
        refundedQuantitiesFor(invoiceNo) {
            const out = new Map();
            for (const r of this.refunds) {
                if (!eqIC(r.originalInvoiceNo, invoiceNo)) continue;
                for (const l of r.lines) out.set(l.itemId, (out.get(l.itemId) || 0) + l.quantity);
            }
            return out;
        }
        createRefund(original, cashier, requests, reason, inventory) {
            if (!original) throw bad("Unknown invoice - cannot process a return without it.");
            if (!requests || !requests.length) throw bad("Pick at least one line to return.");
            const requested = new Map();
            for (const r of requests) {
                if (r.quantity <= 0) continue;
                requested.set(r.itemId, (requested.get(r.itemId) || 0) + r.quantity);
            }
            if (!requested.size) throw bad("Enter a quantity for at least one line.");
            const already = this.refundedQuantitiesFor(original.invoiceNo);
            const byId = mergeLines(original.lines);
            const refundLines = [];
            const restock = [];
            for (const [id, qty] of requested) {
                const src = byId.get(id);
                if (!src) throw bad("Item '" + id + "' was not on this bill.");
                const remaining = src.quantity - (already.get(id) || 0);
                if (qty > remaining + 1e-9) {
                    throw bad("Cannot return " + trimNum(qty) + " " + src.unit + " of '" + src.name + "' - only "
                        + trimNum(remaining) + " remains refundable.");
                }
                const amount = M.times(src.price, qty);
                refundLines.push(makeLine(src.itemId, src.name, src.unit, src.price, src.taxRatePercent, qty, amount,
                    M.taxOf(amount, src.taxRatePercent)));
                restock.push({ itemId: src.itemId, quantity: qty });
            }
            const refund = makeRefund("RFD-" + (maxSuffix(this.refunds.map(r => r.refundNo), 1000) + 1), original.invoiceNo,
                original.branchId, cashier, this.clock.now(), refundLines, reason);
            this.db.inTransaction(() => {
                inventory.restoreStock(original.branchId, restock);
                this.db.update("INSERT INTO refunds(refundNo, originalInvoiceNo, branchId, cashierUsername, dateTime, refundAmount, " +
                    "refundTax, reason) VALUES(?,?,?,?,?,?,?,?)",
                    [refund.refundNo, refund.originalInvoiceNo, refund.branchId, refund.cashierUsername, stampOf(refund.dateTime),
                        M.fmt(refund.refundAmount), M.fmt(refund.refundTax), refund.reason]);
                for (const l of refund.lines) insertLine(this.db, "refund_lines", "refundNo", refund.refundNo, l);
            });
            this.refunds.push(refund);
            return refund;
        }
    }

    // ---------------- passwords (grocery.auth.PasswordHasher) ----------------

    const ITERATIONS = 600000;
    const DECOY_SALT = new Uint8Array(16);
    const b64 = bytes => btoa(String.fromCharCode.apply(null, Array.from(bytes)));
    const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

    class PasswordHasher {
        constructor(random) { this.random = random; }
        async pbkdf2(password, salt, iterations) {
            const subtle = root.crypto.subtle;
            const key = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
            const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
            return new Uint8Array(bits);
        }
        async hash(password) {
            const salt = this.random(16);
            return ITERATIONS + ":" + b64(salt) + ":" + b64(await this.pbkdf2(password, salt, ITERATIONS));
        }
        async verify(password, stored) {
            if (stored == null) return false;
            try {
                const parts = stored.split(":");
                if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false;
                const expected = unb64(parts[2]);
                const actual = await this.pbkdf2(password, unb64(parts[1]), parseInt(parts[0], 10));
                if (actual.length !== expected.length) return false;
                let diff = 0;
                for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
                return diff === 0;
            } catch (e) {
                return false;
            }
        }
        async warmUp(password) { if (password != null) await this.pbkdf2(password, DECOY_SALT, ITERATIONS); }
        randomPassword() {
            const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
            let out = "";
            while (out.length < 12) {
                const b = this.random(1)[0];
                if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
            }
            return out;
        }
        randomToken() {
            return b64(this.random(32)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        }
    }

    class UserService {
        constructor(db, hasher) {
            this.db = db;
            this.hasher = hasher;
            this.users = db.query("SELECT * FROM users").map(r => ({
                username: r.username, passwordHash: r.passwordHash, fullName: r.fullName, role: parseRole(r.role),
                branchId: r.branchId == null ? null : r.branchId, active: r.active !== 0, mustChangePassword: r.mustChangePassword !== 0,
            }));
            this.bootstrapPassword = null;
        }
        /** The async half of the Java constructor: create the first admin on an empty database. */
        async bootstrap() {
            if (this.users.length) return;
            const password = this.hasher.randomPassword();
            const admin = {
                username: "admin", passwordHash: await this.hasher.hash(password), fullName: "Administrator",
                role: "ADMIN", branchId: null, active: true, mustChangePassword: true,
            };
            this.users.push(admin);
            this.insert(admin);
            this.bootstrapPassword = password;
        }
        consumeBootstrapPassword() { const p = this.bootstrapPassword; this.bootstrapPassword = null; return p; }
        getAll() { return this.users.slice(); }
        findByUsername(name) { return name == null ? null : (this.users.find(u => eqIC(u.username, name)) || null); }
        async authenticate(username, password) {
            const u = this.findByUsername(username);
            if (!u || !u.active || password == null) {
                await this.hasher.warmUp(password);
                return null;
            }
            return (await this.hasher.verify(password, u.passwordHash)) ? u : null;
        }
        add(u) {
            if (this.findByUsername(u.username)) throw bad("A user named '" + u.username + "' already exists.");
            this.users.push(u);
            this.insert(u);
        }
        update(u) {
            const i = this.users.findIndex(x => eqIC(x.username, u.username));
            if (i < 0) throw bad("No user named '" + u.username + "'.");
            this.users[i] = u;
            this.db.update("UPDATE users SET passwordHash=?, fullName=?, role=?, branchId=?, active=?, mustChangePassword=? WHERE username=?",
                [u.passwordHash, u.fullName, u.role, u.branchId, u.active ? 1 : 0, u.mustChangePassword ? 1 : 0, u.username]);
        }
        insert(u) {
            this.db.update("INSERT INTO users(username, passwordHash, fullName, role, branchId, active, mustChangePassword) VALUES(?,?,?,?,?,?,?)",
                [u.username, u.passwordHash, u.fullName, u.role, u.branchId, u.active ? 1 : 0, u.mustChangePassword ? 1 : 0]);
        }
    }

    class AuditLogService {
        constructor(db, clock) {
            this.db = db;
            this.clock = clock;
            this.entries = db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 5000").reverse().map(r => ({
                when: parseStamp(r.when) || clock.now(), username: r.username,
                role: r.role == null || r.role === "" ? null : parseRole(r.role),
                branchId: r.branchId == null ? null : r.branchId, action: r.action, details: r.details,
            }));
        }
        log(actor, action, details) {
            this.append({ when: this.clock.now(), username: actor.username, role: actor.role, branchId: actor.branchId, action, details });
        }
        logSystem(action, details) {
            this.append({ when: this.clock.now(), username: "system", role: null, branchId: null, action, details });
        }
        recent(max, branchId) {
            const out = [];
            for (let i = this.entries.length - 1; i >= 0 && out.length < max; i--) {
                const e = this.entries[i];
                if (branchId == null || eqIC(branchId, e.branchId)) out.push(e);
            }
            return out;
        }
        append(e) {
            this.entries.push(e);
            if (this.entries.length > 5000) this.entries.shift();
            this.db.update("INSERT INTO audit_log(\"when\", username, role, branchId, action, details) VALUES(?,?,?,?,?,?)",
                [stampOf(e.when), e.username, e.role, e.branchId, e.action, e.details]);
        }
    }

    class SessionManager {
        constructor(nowMs, hasher) { this.nowMs = nowMs; this.hasher = hasher; this.sessions = new Map(); }
        create(username) {
            const token = this.hasher.randomToken();
            this.sessions.set(token, { token, username, expiresAt: this.nowMs() + 12 * 3600 * 1000 });
            return this.sessions.get(token);
        }
        resolve(token) {
            if (token == null) return null;
            const s = this.sessions.get(token);
            if (!s) return null;
            if (this.nowMs() > s.expiresAt) { this.sessions.delete(token); return null; }
            return s;
        }
        invalidate(token) { if (token != null) this.sessions.delete(token); }
        invalidateAllFor(username) {
            for (const [t, s] of this.sessions) if (eqIC(s.username, username)) this.sessions.delete(t);
        }
        /** Phone only: sessions outlive an app restart the way the PC's 12-hour cookie outlives a browser restart. */
        snapshot() { return [...this.sessions.values()]; }
        load(list) { for (const s of list || []) if (s && s.token && this.nowMs() <= s.expiresAt) this.sessions.set(s.token, s); }
    }

    class LoginRateLimiter {
        constructor(nowMs) { this.nowMs = nowMs; this.failures = new Map(); this.ipFailures = new Map(); }
        lockoutRemaining(username) { return this.remaining(this.failures, key(username), 5, 15, 15); }
        ipLockoutRemaining(ip) { return this.remaining(this.ipFailures, ipKey(ip), 30, 15, 5); }
        remaining(store, k, max, windowMin, lockMin) {
            const hits = this.pruneAndGet(store, k, windowMin);
            if (!hits || hits.length < max) return 0;
            const left = hits[hits.length - 1] + lockMin * 60000 - this.nowMs();
            return left < 0 ? 0 : left;
        }
        recordFailure(username, ip) {
            this.record(this.failures, key(username), 15);
            this.record(this.ipFailures, ipKey(ip), 15);
        }
        recordSuccess(username) { const k = key(username); if (k != null) this.failures.delete(k); }
        record(store, k, windowMin) {
            if (k == null) return;
            if (!store.has(k)) store.set(k, []);
            const hits = store.get(k);
            this.prune(hits, windowMin);
            hits.push(this.nowMs());
        }
        pruneAndGet(store, k, windowMin) {
            if (k == null) return null;
            const hits = store.get(k);
            if (!hits) return null;
            this.prune(hits, windowMin);
            if (!hits.length) { store.delete(k); return null; }
            return hits;
        }
        prune(hits, windowMin) {
            const cutoff = this.nowMs() - windowMin * 60000;
            while (hits.length && hits[0] < cutoff) hits.shift();
        }
    }
    function key(u) { if (u == null) return null; const t = jtrim(String(u)).toLowerCase(); return t === "" ? null : t; }
    function ipKey(ip) { if (ip == null) return null; const t = jtrim(String(ip)); return t === "" ? null : t; }
    /** Duration.toMinutes() */
    const toMinutes = ms => Math.floor(ms / 60000);

    // =====================================================================
    // the app context: all services over one database
    // =====================================================================

    class Context {
        static async open(opts, dbBytes, propsText) {
            const c = new Context();
            c.opts = opts;
            c.clock = new Clock(opts.now);
            c.store = new StoreConfig(propsText, opts.Props);
            if (!c.clock.setZone(c.store.get("timezone"))) c.clock.setZone("Asia/Kolkata");
            c.db = new Db(dbBytes ? new opts.SQL.Database(dbBytes) : new opts.SQL.Database());
            c.hasher = new PasswordHasher(opts.random);
            c.branches = new BranchService(c.db, c.store);
            c.inventory = new InventoryService(c.db, c.branches.defaultBranchId());
            c.invoiceStore = new InvoiceStore(c.db, c.branches, c.clock);
            c.refunds = new RefundService(c.db, c.clock);
            c.users = new UserService(c.db, c.hasher);
            await c.users.bootstrap();
            c.auditLog = new AuditLogService(c.db, c.clock);
            c.sessions = new SessionManager(opts.now, c.hasher);
            c.rateLimiter = new LoginRateLimiter(opts.now);
            c.bootstrapPassword = c.users.consumeBootstrapPassword();
            if (c.bootstrapPassword != null) c.auditLog.logSystem("BOOTSTRAP", "created initial admin account");
            return c;
        }
    }

    // =====================================================================
    // mappers (grocery.web.Mappers) - null fields are dropped at serialization, like Gson
    // =====================================================================

    function branchName(c, id) {
        if (id == null) return "All Branches";
        const b = c.branches.findById(id);
        return b ? b.name : id;
    }
    const mapStore = c => ({
        name: c.store.get("name"), addressLine1: c.store.get("addressLine1"), addressLine2: c.store.get("addressLine2"),
        phone: c.store.get("phone"), email: c.store.get("email"), gstin: c.store.get("gstin"), currency: c.store.get("currency"),
    });
    const mapItem = it => ({
        id: it.id, branchId: it.branchId, name: it.name, category: it.category, unit: it.unit, price: M.num(it.price),
        costPrice: M.num(it.costPrice), taxRatePercent: it.taxRatePercent, stock: it.stock, barcode: it.barcode,
        reorderLevel: it.reorderLevel,
    });
    const mapBranch = b => ({
        id: b.id, name: b.name, addressLine1: b.addressLine1, addressLine2: b.addressLine2, phone: b.phone, gstin: b.gstin,
        stateCode: b.stateCode, active: b.active,
    });
    const mapUser = (c, u) => ({
        username: u.username, fullName: u.fullName, role: u.role, branchId: u.branchId, branchName: branchName(c, u.branchId),
        active: u.active, mustChangePassword: u.mustChangePassword,
    });
    function mapSession(c, u) {
        const d = { username: u.username, fullName: u.fullName, role: u.role, branchId: u.branchId, branchName: branchName(c, u.branchId) };
        if (u.branchId != null) {
            const b = c.branches.findById(u.branchId);
            if (b) {
                d.branchAddressLine1 = b.addressLine1;
                d.branchAddressLine2 = b.addressLine2;
                d.branchPhone = b.phone;
                d.branchGstin = b.gstin;
            }
        }
        d.mustChangePassword = u.mustChangePassword;
        return d;
    }
    const mapAudit = e => ({
        when: fmtAudit(e.when), username: e.username, role: e.role == null ? "" : e.role, branchId: e.branchId,
        action: e.action, details: e.details,
    });
    const mapLine = l => ({
        itemId: l.itemId, name: l.name, unit: l.unit, price: M.num(l.price), taxRatePercent: l.taxRatePercent,
        quantity: l.quantity, amount: M.num(l.amount), tax: M.num(l.tax),
    });
    const mapInvoice = (c, inv) => ({
        invoiceNo: inv.invoiceNo, branchId: inv.branchId, branchName: branchName(c, inv.branchId),
        cashierUsername: inv.cashierUsername, dateTime: fmtDate(inv.dateTime), customerName: inv.customerName,
        customerPhone: inv.customerPhone, paymentMode: inv.paymentMode, lines: inv.lines.map(mapLine),
        subTotal: M.num(inv.subTotal), discount: M.num(inv.discount), totalTax: M.num(inv.totalTax), cgst: M.num(inv.cgst),
        sgst: M.num(inv.sgst), igst: M.num(inv.igst), interState: inv.interState, placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
        netAmount: M.num(inv.netAmount), roundOff: M.num(inv.roundOff), grandTotal: M.num(inv.grandTotal),
        amountPaid: M.num(inv.amountPaid), changeDue: M.num(inv.changeDue), itemCount: inv.lines.length,
        pdfUrl: "/api/invoices/" + inv.invoiceNo + "/pdf", thermalPdfUrl: "/api/invoices/" + inv.invoiceNo + "/pdf?format=thermal",
    });
    const mapRefund = (c, r) => ({
        refundNo: r.refundNo, originalInvoiceNo: r.originalInvoiceNo, branchId: r.branchId, branchName: branchName(c, r.branchId),
        cashierUsername: r.cashierUsername, dateTime: fmtDate(r.dateTime), reason: r.reason, lines: r.lines.map(mapLine),
        refundAmount: M.num(r.refundAmount), refundTax: M.num(r.refundTax), itemCount: r.lines.length,
    });

    // =====================================================================
    // request handling (grocery.web.ApiHandler + AuthFilter)
    // =====================================================================

    function parseQuery(raw) {
        const params = new Map();
        if (!raw) return params;
        const decode = s => decodeURIComponent(s.replace(/\+/g, " "));
        for (const pair of raw.split("&")) {
            const eq = pair.indexOf("=");
            try {
                if (eq >= 0) params.set(decode(pair.slice(0, eq)), decode(pair.slice(eq + 1)));
                else params.set(decode(pair), "");
            } catch (e) {
                throw bad("URLDecoder: Illegal hex characters in escape (%) pattern");
            }
        }
        return params;
    }

    const REQUIRED_TABLES = ["branches", "items", "users", "invoices", "invoice_lines", "refunds", "refund_lines", "audit_log"];
    const SQLITE_MAGIC = "SQLite format 3\u0000";

    class Backend {
        constructor(opts, ctx) {
            this.opts = opts;
            this.c = ctx;
            this.queue = Promise.resolve();
            this.propsDirty = ctx.store.dirty;
        }

        /** One request at a time - the Java services are all synchronized on shared state. */
        handle(req) {
            const run = this.queue.then(() => this.dispatch(req));
            this.queue = run.catch(() => {});
            return run;
        }

        async dispatch(req) {
            const res = { status: 200, contentType: "application/json; charset=utf-8", headers: {}, body: null, setSid: undefined };
            try {
                await this.route(req, res);
            } catch (e) {
                let status, message;
                if (e instanceof ApiError) { status = e.status; message = e.message; }
                else if (e instanceof BadRequest) { status = 400; message = e.message; }
                else {
                    const cid = Math.random().toString(16).slice(2, 10);
                    (this.opts.log || console.error)("Unhandled server error [" + cid + "] " + req.method + " " + req.path, e);
                    status = 500; message = "Server error (ref: " + cid + ")";
                }
                res.status = status;
                res.contentType = "application/json; charset=utf-8";
                res.headers = {};
                res.body = JSON.stringify({ error: message });
            }
            return res;
        }

        json(res, status, obj) {
            res.status = status;
            res.body = JSON.stringify(obj, (k, v) => (v === null ? undefined : v));
        }
        bytes(res, status, contentType, bytes, disposition) {
            res.status = status;
            res.contentType = contentType;
            res.body = bytes;
            if (disposition) res.headers["Content-Disposition"] = disposition;
        }

        async route(req, res) {
            const c = this.c;
            const method = req.method.toUpperCase();
            let path = req.path;
            try { path = decodeURIComponent(path); } catch (e) { /* leave as is */ }
            let sub = path.slice("/api".length);
            if (sub.length > 1 && sub.endsWith("/")) sub = sub.slice(0, -1);
            const q = parseQuery(req.query || "");
            const body = () => {
                const t = req.body == null ? "" : (typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
                if (jtrim(t) === "") return null;
                return JSON.parse(t);
            };

            if (sub === "/store" && method === "GET") return this.json(res, 200, mapStore(c));
            if (sub === "/auth/login" && method === "POST") return this.login(res, body());

            const session = c.sessions.resolve(req.sid);
            const user = session ? c.users.findByUsername(session.username) : null;
            if (!session || !user || !user.active) throw new ApiError(401, "Not signed in.");

            if (user.mustChangePassword
                && !(method === "GET" && sub === "/auth/me")
                && !(method === "POST" && sub === "/auth/change-password")
                && !(method === "POST" && sub === "/auth/logout")) {
                throw forbidden("Please set a new password before continuing.");
            }

            const tail = (prefix, suffix) => sub.slice(prefix.length, sub.length - (suffix || "").length);
            if (sub === "/auth/me" && method === "GET") return this.json(res, 200, mapSession(c, user));
            if (sub === "/auth/logout" && method === "POST") return this.logout(res, user, req.sid);
            if (sub === "/auth/change-password" && method === "POST") return this.changePassword(res, user, body());
            if (sub === "/branches" && method === "GET") { requireRole(user, "ADMIN"); return this.json(res, 200, c.branches.getAll().map(mapBranch)); }
            if (sub === "/branches" && method === "POST") return this.addBranch(res, user, body());
            if (sub.startsWith("/branches/") && method === "PUT") return this.updateBranch(res, user, tail("/branches/"), body());
            if (sub === "/users" && method === "GET") { requireRole(user, "ADMIN"); return this.json(res, 200, c.users.getAll().map(u => mapUser(c, u))); }
            if (sub === "/users" && method === "POST") return this.addUser(res, user, body());
            if (sub.startsWith("/users/") && method === "PUT") return this.updateUser(res, user, tail("/users/"), body());
            if (sub === "/audit-log" && method === "GET") return this.auditLog(res, user, q);
            if (sub === "/admin/backup" && method === "GET") return this.backup(res, user);
            if (sub === "/admin/restore" && method === "POST") return this.restore(res, user, req.body);
            if (sub === "/store" && method === "PUT" && this.opts.singleShop) return this.updateStore(res, user, body());
            if (sub === "/dashboard" && method === "GET") return this.json(res, 200, this.dashboard(user, q));
            if (sub === "/reports/z" && method === "GET") return this.json(res, 200, this.zReport(user, q));
            if (sub === "/reports/z.pdf" && method === "GET") return this.zReportPdf(res, user, q);
            if (sub === "/items" && method === "GET") return this.listItems(res, user, q);
            if (sub === "/items" && method === "POST") return this.addItem(res, user, body());
            if (sub.startsWith("/items/") && sub.endsWith("/adjust-stock") && method === "POST") {
                return this.adjustStock(res, user, tail("/items/", "/adjust-stock"), body());
            }
            if (sub.startsWith("/items/") && method === "PUT") return this.updateItem(res, user, tail("/items/"), body());
            if (sub.startsWith("/items/") && method === "DELETE") return this.deleteItem(res, user, tail("/items/"), q);
            if (sub === "/invoices.csv" && method === "GET") return this.invoicesCsv(res, user, q);
            if (sub === "/invoices" && method === "GET") return this.listInvoices(res, user, q);
            if (sub.startsWith("/invoices/") && sub.endsWith("/pdf") && method === "GET") return this.invoicePdf(res, user, tail("/invoices/", "/pdf"), q);
            if (sub.startsWith("/invoices/") && sub.endsWith("/refundable") && method === "GET") return this.refundable(res, user, tail("/invoices/", "/refundable"));
            if (sub.startsWith("/invoices/") && method === "GET") return this.json(res, 200, mapInvoice(c, this.invoiceInScope(user, tail("/invoices/"))));
            if (sub === "/checkout" && method === "POST") return this.checkout(res, user, body());
            if (sub === "/customers" && method === "GET") return this.customers(res, user, q);
            if (sub === "/customers/history" && method === "GET") return this.customerHistory(res, user, q);
            if (sub === "/refunds" && method === "GET") return this.listRefunds(res, user, q);
            if (sub === "/refunds" && method === "POST") return this.createRefund(res, user, body());
            if (sub.startsWith("/refunds/") && method === "GET") return this.refundDetail(res, user, tail("/refunds/"));
            return this.json(res, 404, { error: "No such endpoint: " + method + " " + path });
        }

        // ---------------- auth ----------------

        async login(res, dto) {
            const c = this.c;
            if (dto == null || dto.username == null || dto.password == null) throw bad("Username and password are required.");
            const username = str(dto.username), password = str(dto.password);
            const ip = this.opts.remoteIp || "127.0.0.1";
            const ipWait = c.rateLimiter.ipLockoutRemaining(ip);
            if (ipWait !== 0) {
                c.auditLog.logSystem("LOGIN_IP_LOCKED", "ip=" + ip + " retry in " + Math.max(1, toMinutes(ipWait)) + "m");
                throw new ApiError(429, "Too many failed attempts. Try again in about " + Math.max(1, toMinutes(ipWait)) + " minute(s).");
            }
            const wait = c.rateLimiter.lockoutRemaining(username);
            if (wait !== 0) {
                c.auditLog.logSystem("LOGIN_LOCKED", "username=" + username + " retry in " + toMinutes(wait) + "m");
                throw new ApiError(429, "Too many failed attempts. Try again in about " + Math.max(1, toMinutes(wait)) + " minute(s).");
            }
            const user = await c.users.authenticate(username, password);
            if (!user) {
                c.rateLimiter.recordFailure(username, ip);
                c.auditLog.logSystem("LOGIN_FAILED", "username=" + username + " ip=" + ip);
                throw new ApiError(401, "Invalid username or password.");
            }
            c.rateLimiter.recordSuccess(user.username);
            res.setSid = c.sessions.create(user.username).token;
            c.auditLog.log(user, "LOGIN", "");
            this.json(res, 200, mapSession(c, user));
        }

        logout(res, user, sid) {
            this.c.sessions.invalidate(sid);
            res.setSid = "";
            this.c.auditLog.log(user, "LOGOUT", "");
            this.json(res, 200, { ok: true });
        }

        async changePassword(res, user, dto) {
            const c = this.c;
            const next = dto == null ? null : str(dto.newPassword);
            if (dto == null || next == null || next.length < 6) throw bad("New password must be at least 6 characters.");
            if (!user.mustChangePassword && (dto.currentPassword == null
                || !(await c.hasher.verify(str(dto.currentPassword), user.passwordHash)))) {
                throw bad("Current password is incorrect.");
            }
            user.passwordHash = await c.hasher.hash(next);
            user.mustChangePassword = false;
            c.users.update(user);
            c.sessions.invalidateAllFor(user.username);
            res.setSid = c.sessions.create(user.username).token;
            c.auditLog.log(user, "PASSWORD_CHANGE", "");
            this.json(res, 200, mapSession(c, user));
        }

        // ---------------- branches, store, users ----------------

        addBranch(res, user, dto) {
            const c = this.c;
            requireRole(user, "ADMIN");
            if (this.opts.singleShop) {
                throw bad("This phone app runs one shop. Use the PC version to manage several branches.");
            }
            if (dto == null || dto.name == null || jtrim(str(dto.name)) === "") throw bad("Branch name is required.");
            const b = branchFromDto(null, dto, true);
            c.branches.add(b);
            if (dto.cloneFromBranchId != null && dto.cloneFromBranchId !== "") {
                c.branches.require(str(dto.cloneFromBranchId));
                c.inventory.cloneCatalogue(str(dto.cloneFromBranchId), b.id);
            }
            c.auditLog.log(user, "BRANCH_CREATE", b.id + " " + b.name);
            this.json(res, 201, mapBranch(b));
        }

        updateBranch(res, user, id, dto) {
            const c = this.c;
            requireRole(user, "ADMIN");
            if (dto == null || dto.name == null || jtrim(str(dto.name)) === "") throw bad("Branch name is required.");
            const b = branchFromDto(id, dto, bool(dto.active));
            c.branches.update(b);
            c.auditLog.log(user, "BRANCH_UPDATE", b.id + " " + b.name);
            this.json(res, 200, mapBranch(b));
        }

        /**
         * Phone only. The PC reads the shop's name/address/GSTIN from store.properties, which the
         * owner edits by hand; a phone has no such file to edit, so the Shop screen saves it here.
         * The one branch mirrors the same details, so the sidebar, invoices and reports agree.
         */
        updateStore(res, user, dto) {
            const c = this.c;
            requireRole(user, "ADMIN");
            if (dto == null || dto.name == null || jtrim(str(dto.name)) === "") throw bad("Shop name is required.");
            const currency = oneLine(str(dto.currency));
            c.store.set("name", oneLine(str(dto.name)));
            c.store.set("addressLine1", oneLine(str(dto.addressLine1)));
            c.store.set("addressLine2", oneLine(str(dto.addressLine2)));
            c.store.set("phone", oneLine(str(dto.phone)));
            c.store.set("email", oneLine(str(dto.email)));
            c.store.set("gstin", oneLine(str(dto.gstin)).toUpperCase());
            c.store.set("currency", currency === "" ? "Rs." : currency);
            this.propsDirty = true;
            const b = c.branches.findById(c.branches.defaultBranchId());
            c.branches.update({
                id: b.id, name: c.store.get("name"), addressLine1: c.store.get("addressLine1"),
                addressLine2: c.store.get("addressLine2"), phone: c.store.get("phone"), gstin: c.store.get("gstin"),
                stateCode: oneLine(str(dto.stateCode)).toUpperCase(), active: true,
            });
            c.auditLog.log(user, "STORE_UPDATE", c.store.get("name"));
            this.json(res, 200, mapStore(c));
        }

        async addUser(res, actor, dto) {
            const c = this.c;
            requireRole(actor, "ADMIN");
            if (dto == null || dto.username == null || jtrim(str(dto.username)) === "") throw bad("Username is required.");
            const password = str(dto.password);
            if (password == null || password.length < 6) throw bad("Password must be at least 6 characters.");
            const role = parseRole(str(dto.role));
            const branchId = this.branchForRole(role, str(dto.branchId));
            const u = {
                username: oneLine(str(dto.username)), passwordHash: await c.hasher.hash(password), fullName: oneLine(str(dto.fullName)),
                role, branchId, active: true, mustChangePassword: true,
            };
            c.users.add(u);
            c.auditLog.log(actor, "USER_CREATE", u.username + " role=" + role);
            this.json(res, 201, mapUser(c, u));
        }

        async updateUser(res, actor, username, dto) {
            const c = this.c;
            requireRole(actor, "ADMIN");
            const existing = c.users.findByUsername(username);
            if (!existing) throw notFound("No user named '" + username + "'.");
            if (dto == null) throw bad("Missing user data.");
            const role = parseRole(str(dto.role));
            const branchId = this.branchForRole(role, str(dto.branchId));
            const active = bool(dto.active);
            if (eqIC(existing.username, actor.username)) {
                if (role !== "ADMIN") throw bad("You cannot remove your own admin role.");
                if (!active) throw bad("You cannot deactivate your own account.");
            }
            existing.fullName = oneLine(str(dto.fullName));
            existing.role = role;
            existing.branchId = branchId;
            existing.active = active;
            const password = str(dto.password);
            if (password != null && password !== "") {
                if (password.length < 6) throw bad("Password must be at least 6 characters.");
                existing.passwordHash = await c.hasher.hash(password);
                existing.mustChangePassword = true;
                c.sessions.invalidateAllFor(existing.username);
            }
            c.users.update(existing);
            c.auditLog.log(actor, "USER_UPDATE", existing.username);
            this.json(res, 200, mapUser(c, existing));
        }

        branchForRole(role, requested) {
            if (role === "ADMIN") return null;
            if (requested == null || requested === "") throw bad("Manager and Cashier accounts must be assigned a branch.");
            this.c.branches.require(requested);
            return requested;
        }

        auditLog(res, user, q) {
            requireRole(user, "ADMIN");
            let filter = q.get("branchId");
            if (filter != null && (filter === "" || eqIC(filter, "all"))) filter = null;
            const entries = this.c.auditLog.recent(500, filter == null ? null : filter);
            if (!q.get("limit")) return this.json(res, 200, entries.map(mapAudit));
            this.json(res, 200, paginate(entries, q, mapAudit));
        }

        // ---------------- items ----------------

        listItems(res, user, q) {
            const c = this.c;
            const branchId = this.branchId(user, q);
            const barcode = q.get("barcode");
            if (barcode != null && barcode !== "") {
                const hit = c.inventory.findByBarcode(branchId, barcode) || c.inventory.findInBranch(branchId, barcode);
                return this.json(res, 200, hit ? [mapItem(hit)] : []);
            }
            const matches = c.inventory.search(branchId, q.has("q") ? q.get("q") : null);
            if (!q.get("limit")) return this.json(res, 200, matches.map(mapItem));
            this.json(res, 200, paginate(matches, q, mapItem));
        }

        addItem(res, user, dto) {
            const c = this.c;
            requireRole(user, "ADMIN", "MANAGER");
            const branchId = this.branchIdForBody(user, dto == null ? null : str(dto.branchId));
            const item = toItem(dto, dto != null ? str(dto.id) : null, branchId);
            c.inventory.add(item);
            c.auditLog.log(user, "ITEM_CREATE", item.id + " " + item.name);
            this.json(res, 201, mapItem(item));
        }

        updateItem(res, user, id, dto) {
            const c = this.c;
            requireRole(user, "ADMIN", "MANAGER");
            const branchId = this.branchIdForBody(user, dto == null ? null : str(dto.branchId));
            const previous = c.inventory.findInBranch(branchId, id);
            const item = toItem(dto, id, branchId);
            if (dto != null && dto.costPrice == null && previous) item.costPrice = previous.costPrice;
            c.inventory.update(branchId, item);
            const change = previous && previous.price !== item.price
                ? " price " + M.fmt(previous.price) + " -> " + M.fmt(item.price) : "";
            c.auditLog.log(user, "ITEM_UPDATE", item.id + " " + item.name + change);
            this.json(res, 200, mapItem(item));
        }

        adjustStock(res, user, id, dto) {
            const c = this.c;
            requireRole(user, "ADMIN", "MANAGER");
            if (dto == null) throw bad("Missing request body.");
            const branchId = this.branchIdForBody(user, str(dto.branchId));
            const before = c.inventory.findInBranch(branchId, id);
            if (!before) throw bad("No item with id '" + id + "' in this branch.");
            const deltaIn = boxed(dto.delta), newStock = boxed(dto.newStock);
            let delta;
            if (deltaIn != null) delta = deltaIn;
            else if (newStock != null) delta = newStock - before.stock;
            else throw bad("Provide either 'delta' or 'newStock'.");
            if (!Number.isFinite(delta)) throw bad("Stock change must be a finite number.");
            c.inventory.adjustStock(branchId, id, delta);
            const after = c.inventory.findInBranch(branchId, id);
            const reason = dto.reason == null ? "" : jtrim(str(dto.reason));
            const details = id + " " + before.name + " " + (delta >= 0 ? "+" : "") + jd(delta)
                // Java builds this after the adjust from the same Item object, so the "before"
                // figure already shows the new stock. Mirrored as-is to keep the audit trails identical.
                + " (" + jd(before.stock) + " -> " + (after ? jd(after.stock) : "?") + ")"
                + (reason === "" ? "" : " reason=" + reason);
            c.auditLog.log(user, "STOCK_ADJUST", details);
            this.json(res, 200, mapItem(after));
        }

        deleteItem(res, user, id, q) {
            requireRole(user, "ADMIN", "MANAGER");
            const branchId = this.branchId(user, q);
            this.c.inventory.delete(branchId, id);
            this.c.auditLog.log(user, "ITEM_DELETE", id);
            this.json(res, 200, { ok: true });
        }

        // ---------------- invoices ----------------

        invoicesFor(user, q) {
            const b = this.branchIdOrAll(user, q);
            return b == null ? this.c.invoiceStore.getAll() : this.c.invoiceStore.getAllForBranch(b);
        }

        invoicesCsv(res, user, q) {
            const c = this.c;
            const list = filterByDate(q, this.invoicesFor(user, q));
            let sb = "Invoice No,Date,Branch,Cashier,Customer,Phone,Payment,Place of Supply,"
                + "Sub Total,Discount,CGST,SGST,IGST,Round Off,Grand Total\r\n";
            for (const inv of list) {
                const d = mapInvoice(c, inv);
                sb += [csvCell(inv.invoiceNo), csvCell(d.dateTime), csvCell(d.branchName), csvCell(inv.cashierUsername),
                    csvCell(inv.customerName), csvCell(inv.customerPhone), csvCell(inv.paymentMode), csvCell(inv.placeOfSupplyStateCode),
                    M.fmt(inv.subTotal), M.fmt(inv.discount), M.fmt(inv.cgst), M.fmt(inv.sgst), M.fmt(inv.igst),
                    M.fmt(inv.roundOff), M.fmt(inv.grandTotal)].join(",") + "\r\n";
            }
            const stamp = (q.has("from") ? q.get("from") : "all") + "_to_" + (q.has("to") ? q.get("to") : "all");
            this.bytes(res, 200, "text/csv; charset=utf-8", new TextEncoder().encode(sb),
                "attachment; filename=\"invoices-" + stamp + ".csv\"");
        }

        listInvoices(res, user, q) {
            const c = this.c;
            const list = filterByDate(q, this.invoicesFor(user, q));
            if (!q.get("limit")) return this.json(res, 200, list.map(inv => mapInvoice(c, inv)));
            this.json(res, 200, paginate(list, q, inv => mapInvoice(c, inv)));
        }

        invoiceInScope(user, no) {
            const inv = this.c.invoiceStore.findByNo(no);
            if (!inv) throw notFound("Invoice not found: " + no);
            if (!canAccessBranch(user, inv.branchId)) throw forbidden("That invoice belongs to another branch.");
            return inv;
        }

        invoicePdf(res, user, no, q) {
            const inv = this.invoiceInScope(user, no);
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(inv.invoiceNo)) throw notFound("Invoice not found: " + no);
            const thermal = eqIC("thermal", q.get("format") || "");
            const pdf = this.opts.Pdf;
            if (!pdf) throw new Error("PDF engine not loaded");
            const input = pdfInput(this.c, inv);
            const bytes = thermal ? pdf.thermalPdf(input) : pdf.invoicePdf(input);
            const name = inv.invoiceNo + (thermal ? "-thermal.pdf" : ".pdf");
            this.bytes(res, 200, "application/pdf", bytes, "inline; filename=\"" + name + "\"");
        }

        checkout(res, user, dto) {
            const c = this.c;
            if (dto == null) throw bad("Missing checkout data.");
            const discount = sanitizeMoney(dbl(dto.discount), "discount");
            const paid = sanitizeMoney(dbl(dto.amountPaid), "amount paid");
            const branchId = this.branchIdForBody(user, str(dto.branchId));
            const lines = [];
            for (const l of dto.lines || []) {
                const qty = dbl(l.quantity);
                if (!Number.isFinite(qty) || qty < 0 || qty > 1000000) throw bad("Line quantity is out of range.");
                lines.push({ itemId: str(l.itemId), quantity: qty });
            }
            const branch = c.branches.findById(branchId);
            const branchState = branch ? branch.stateCode : "";
            const pos = dto.placeOfSupplyStateCode == null ? "" : jtrim(str(dto.placeOfSupplyStateCode)).toUpperCase();
            const inv = billingCheckout(c, branchId, user.username, str(dto.customerName), str(dto.customerPhone),
                str(dto.paymentMode), discount, paid, lines, pos, branchState);
            c.auditLog.log(user, "CHECKOUT", inv.invoiceNo + " " + M.fmt(inv.grandTotal));
            this.json(res, 201, mapInvoice(c, inv));
        }

        // ---------------- customers ----------------

        customers(res, user, q) {
            const c = this.c;
            const list = this.invoicesFor(user, q);
            const needle = jtrim(q.has("q") ? q.get("q") : "").toLowerCase();
            const agg = new Map();
            for (const inv of list) {
                const phone = inv.customerPhone == null ? "" : jtrim(inv.customerPhone);
                const name = inv.customerName == null ? "" : jtrim(inv.customerName);
                if (phone === "" && (name === "" || eqIC(name, "Walk-in Customer"))) continue;
                const k = phone === "" ? "name:" + name.toLowerCase() : "phone:" + phone;
                let cs = agg.get(k);
                if (!cs) { cs = { phone, name, invoiceCount: 0, totalSpent: 0, lastVisit: null, lastInvoiceNo: null }; agg.set(k, cs); }
                cs.invoiceCount++;
                cs.totalSpent += M.num(inv.grandTotal);
                // NOTE: compares "dd-MM-yyyy HH:mm" strings, exactly like the Java code does.
                const stamped = fmtDate(inv.dateTime);
                if (cs.lastVisit == null || stamped > cs.lastVisit) {
                    cs.lastVisit = stamped;
                    cs.lastInvoiceNo = inv.invoiceNo;
                    if (name !== "") cs.name = name;
                }
            }
            let out = [...agg.values()];
            if (needle !== "") out = out.filter(x => x.phone.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle));
            out.sort((a, b) => b.lastVisit == null ? -1 : a.lastVisit == null ? 1 : (b.lastVisit < a.lastVisit ? -1 : b.lastVisit > a.lastVisit ? 1 : 0));
            for (const x of out) x.totalSpent = round2(x.totalSpent);
            if (!q.get("limit")) return this.json(res, 200, out.slice(0, 200));
            this.json(res, 200, paginate(out, q, x => x));
        }

        customerHistory(res, user, q) {
            const c = this.c;
            const list = this.invoicesFor(user, q);
            const phone = jtrim(q.has("phone") ? q.get("phone") : "");
            const name = jtrim(q.has("name") ? q.get("name") : "");
            if (phone === "" && name === "") throw bad("Provide 'phone' or 'name'.");
            const out = [];
            for (const inv of list) {
                const phoneMatch = phone !== "" && eqIC(phone, inv.customerPhone == null ? "" : jtrim(inv.customerPhone));
                const nameMatch = phone === "" && name !== "" && eqIC(name, inv.customerName == null ? "" : jtrim(inv.customerName));
                if (phoneMatch || nameMatch) out.push(mapInvoice(c, inv));
            }
            this.json(res, 200, out);
        }

        // ---------------- refunds ----------------

        refundable(res, user, no) {
            const c = this.c;
            const inv = this.invoiceInScope(user, no);
            const already = c.refunds.refundedQuantitiesFor(inv.invoiceNo);
            const lines = [...mergeLines(inv.lines).values()].map(l => {
                const done = already.get(l.itemId) || 0;
                return {
                    itemId: l.itemId, name: l.name, unit: l.unit, price: M.num(l.price), taxRatePercent: l.taxRatePercent,
                    originalQuantity: l.quantity, alreadyRefunded: done, remaining: Math.max(0, l.quantity - done),
                };
            });
            this.json(res, 200, {
                invoiceNo: inv.invoiceNo, branchId: inv.branchId, dateTime: fmtDate(inv.dateTime), customerName: inv.customerName,
                paymentMode: inv.paymentMode, grandTotal: M.num(inv.grandTotal), lines, anyRefundable: lines.some(l => l.remaining > 0),
            });
        }

        refundsFor(user, q) {
            const b = this.branchIdOrAll(user, q);
            return b == null ? this.c.refunds.getAll() : this.c.refunds.getAllForBranch(b);
        }

        listRefunds(res, user, q) {
            const c = this.c;
            const list = filterByDate(q, this.refundsFor(user, q));
            if (!q.get("limit")) return this.json(res, 200, list.map(r => mapRefund(c, r)));
            this.json(res, 200, paginate(list, q, r => mapRefund(c, r)));
        }

        refundDetail(res, user, no) {
            const r = this.c.refunds.findByNo(no);
            if (!r) throw notFound("Refund not found: " + no);
            if (!canAccessBranch(user, r.branchId)) throw forbidden("That refund belongs to another branch.");
            this.json(res, 200, mapRefund(this.c, r));
        }

        createRefund(res, user, dto) {
            const c = this.c;
            requireRole(user, "ADMIN", "MANAGER");
            if (dto == null || dto.originalInvoiceNo == null || dto.originalInvoiceNo === "") throw bad("Original invoice number is required.");
            const original = this.invoiceInScope(user, str(dto.originalInvoiceNo));
            const lines = (dto.lines || []).map(l => ({ itemId: str(l.itemId), quantity: dbl(l.quantity) }));
            const refund = c.refunds.createRefund(original, user.username, lines, str(dto.reason), c.inventory);
            c.auditLog.log(user, "REFUND", refund.refundNo + " for " + refund.originalInvoiceNo + " " + M.fmt(refund.refundAmount));
            this.json(res, 201, mapRefund(c, refund));
        }

        // ---------------- reports ----------------

        dashboard(user, params) {
            const c = this.c;
            const branchId = this.branchIdOrAll(user, params);
            const invoices = filterByDate(params, branchId == null ? c.invoiceStore.getAll() : c.invoiceStore.getAllForBranch(branchId));
            const items = branchId == null ? c.branches.getAll().flatMap(b => c.inventory.getAll(b.id)) : c.inventory.getAll(branchId);
            const d = {
                allBranches: branchId == null, branchId,
                branchName: branchId == null ? "All Branches" : c.branches.require(branchId).name,
                periodFrom: parseDate(params.get("from")), periodTo: parseDate(params.get("to")),
            };
            let total = 0;
            for (const inv of invoices) total += M.num(inv.grandTotal);
            d.totalSales = round2(total);
            const refunds = filterByDate(params, branchId == null ? c.refunds.getAll() : c.refunds.getAllForBranch(branchId));
            let refundTotal = 0;
            for (const r of refunds) refundTotal += M.num(r.refundAmount);
            d.refundTotal = round2(refundTotal);
            d.refundCount = refunds.length;
            d.netSales = round2(total - refundTotal);
            d.previousNetSales = 0;
            d.invoiceCount = invoices.length;
            d.itemCount = items.length;

            const categoryOf = new Map(), costOf = new Map();
            for (const it of items) { categoryOf.set(it.id, it.category); costOf.set(it.id, M.num(it.costPrice)); }
            const revenueByCategory = new Map(), profitByCategory = new Map();
            let totalCogs = 0, coveredRevenue = 0;
            const anyItemHasCost = items.some(it => it.costPrice > 0);
            for (const inv of invoices) {
                for (const line of inv.lines) {
                    const cat = categoryOf.has(line.itemId) ? categoryOf.get(line.itemId) : "Other";
                    const amount = M.num(line.amount);
                    revenueByCategory.set(cat, (revenueByCategory.has(cat) ? revenueByCategory.get(cat) : 0) + amount);
                    const cost = (costOf.has(line.itemId) ? costOf.get(line.itemId) : 0) * line.quantity;
                    if (cost > 0) {
                        profitByCategory.set(cat, (profitByCategory.has(cat) ? profitByCategory.get(cat) : 0) + (amount - cost));
                        totalCogs += cost;
                        coveredRevenue += amount;
                    }
                }
            }
            for (const r of refunds) {
                for (const rl of r.lines) {
                    const cost = (costOf.has(rl.itemId) ? costOf.get(rl.itemId) : 0) * rl.quantity;
                    if (cost > 0) { totalCogs -= cost; coveredRevenue -= M.num(rl.amount); }
                }
            }
            const top = (m, n) => [...m.entries()].sort((a, b) => dcmp(b[1], a[1])).slice(0, n);
            d.lowStockCount = 0;
            d.averageSale = invoices.length ? round2(total / invoices.length) : 0;
            d.categoryRevenue = top(revenueByCategory, 6).map(([category, amount]) => ({ category, amount: round2(amount) }));

            d.branchRevenue = [];
            if (branchId == null) {
                const byBranch = new Map();
                for (const inv of invoices) {
                    const a = byBranch.get(inv.branchId) || [0, 0];
                    a[0] += M.num(inv.grandTotal); a[1] += 1;
                    byBranch.set(inv.branchId, a);
                }
                for (const b of c.branches.getAll()) {
                    const a = byBranch.get(b.id) || [0, 0];
                    d.branchRevenue.push({ branchId: b.id, branchName: b.name, amount: round2(a[0]), invoiceCount: a[1] });
                }
                d.branchRevenue.sort((a, b) => dcmp(b.amount, a.amount));
            }
            d.lowStock = items.filter(it => it.stock <= it.reorderLevel).map(it => ({
                id: it.id, branchId: it.branchId, name: it.name, unit: it.unit, stock: it.stock, reorderLevel: it.reorderLevel,
            })).sort((a, b) => dcmp(a.stock, b.stock));
            d.lowStockCount = d.lowStock.length;
            d.recentInvoices = invoices.slice(0, 5).map(inv => ({
                invoiceNo: inv.invoiceNo, dateTime: fmtDate(inv.dateTime), customerName: inv.customerName, grandTotal: M.num(inv.grandTotal),
            }));
            const byMode = new Map();
            for (const inv of invoices) {
                const mode = inv.paymentMode == null || inv.paymentMode === "" ? "Other" : inv.paymentMode;
                const a = byMode.get(mode) || [0, 0];
                a[0] += 1; a[1] += M.num(inv.grandTotal);
                byMode.set(mode, a);
            }
            d.paymentMix = [...byMode.entries()].sort((a, b) => dcmp(b[1][1], a[1][1]))
                .map(([mode, a]) => ({ mode, count: a[0], amount: round2(a[1]) }));
            d.topItems = topItems(invoices, 5).map(t => ({ name: t.name, quantity: t.quantity, unit: t.unit, amount: round2(t.amount) }));
            d.profit = round2(coveredRevenue - totalCogs);
            d.cogs = round2(totalCogs);
            d.grossMarginPercent = coveredRevenue > 0 ? round2((coveredRevenue - totalCogs) / coveredRevenue * 100) : 0;
            d.profitCoverage = anyItemHasCost ? round2(coveredRevenue) : 0;
            d.profitCoverableRevenue = round2(total - refundTotal);
            d.categoryProfit = top(profitByCategory, 6).map(([category, amount]) => ({ category, amount: round2(amount) }));

            const pFrom = parseDate(params.get("from")), pTo = parseDate(params.get("to"));
            if (pFrom != null && pTo != null && !(pTo < pFrom)) {
                const days = daysBetween(pFrom, pTo) + 1;
                const prevTo = addDays(pFrom, -1);
                const prevFrom = addDays(prevTo, -(days - 1));
                const inRange = dt => { const day = dt.s.slice(0, 10); return !(day < prevFrom) && !(day > prevTo); };
                let prevTotal = 0, prevRefund = 0;
                for (const inv of (branchId == null ? c.invoiceStore.getAll() : c.invoiceStore.getAllForBranch(branchId))) {
                    if (inRange(inv.dateTime)) prevTotal += M.num(inv.grandTotal);
                }
                for (const r of (branchId == null ? c.refunds.getAll() : c.refunds.getAllForBranch(branchId))) {
                    if (inRange(r.dateTime)) prevRefund += M.num(r.refundAmount);
                }
                d.previousNetSales = round2(prevTotal - prevRefund);
            }
            return d;
        }

        zReport(user, q) {
            const c = this.c;
            const date = parseDate(q.get("date")) || c.clock.today();
            const branchId = this.branchIdOrAll(user, q);
            const all = branchId == null ? c.invoiceStore.getAll() : c.invoiceStore.getAllForBranch(branchId);
            const day = all.filter(inv => inv.dateTime.s.slice(0, 10) === date).sort((a, b) => cmpDt(a.dateTime, b.dateTime));
            const z = {
                date, branchId, branchName: branchId == null ? "All Branches" : c.branches.require(branchId).name,
                allBranches: branchId == null, invoiceCount: day.length,
                firstInvoiceNo: day.length ? day[0].invoiceNo : null, lastInvoiceNo: day.length ? day[day.length - 1].invoiceNo : null,
            };
            let sub = 0, discount = 0, cgst = 0, sgst = 0, igst = 0, roundOff = 0, grand = 0, cashSales = 0, cashDrawer = 0;
            const pay = new Map();
            for (const inv of day) {
                sub += inv.subTotal; discount += inv.discount; cgst += inv.cgst; sgst += inv.sgst; igst += inv.igst;
                roundOff += inv.roundOff; grand += inv.grandTotal;
                const mode = inv.paymentMode == null || inv.paymentMode === "" ? "Other" : inv.paymentMode;
                const a = pay.get(mode) || [0, 0];
                a[0]++; a[1] += inv.grandTotal;
                pay.set(mode, a);
                if (eqIC(mode, "Cash")) { cashSales += inv.grandTotal; cashDrawer += inv.grandTotal; }
            }
            Object.assign(z, {
                subTotal: M.num(sub), discount: M.num(discount), cgst: M.num(cgst), sgst: M.num(sgst), igst: M.num(igst),
                roundOff: M.num(roundOff), grandTotal: M.num(grand), cashSales: M.num(cashSales),
            });
            const refunds = (branchId == null ? c.refunds.getAll() : c.refunds.getAllForBranch(branchId))
                .filter(r => r.dateTime.s.slice(0, 10) === date);
            let refundTotal = 0;
            for (const r of refunds) refundTotal += r.refundAmount;
            z.cashInDrawer = M.num(cashDrawer - refundTotal);
            z.refundTotal = M.num(refundTotal);
            z.refundCount = refunds.length;
            z.netSales = M.num(grand - refundTotal);
            z.byPayment = [...pay.entries()].map(([mode, a]) => ({ mode, count: a[0], amount: M.num(a[1]) }))
                .sort((a, b) => dcmp(b.amount, a.amount));
            z.topItems = topItems(day, 10);
            return z;
        }

        zReportPdf(res, user, q) {
            const z = this.zReport(user, q);
            const cur = this.c.store.get("currency") + " ";
            const Pdf = this.opts.Pdf;
            if (!Pdf) throw new Error("PDF engine not loaded");
            const money = v => M.fmt(M.of(v));
            const d = new Pdf.PdfDocument();
            d.newPage();
            let y = 60;
            d.text(50, y, 18, true, "Day-End Z-Report");
            y += 22;
            d.text(50, y, 11, false, z.branchName + "  ·  " + z.date);
            y += 22;
            d.text(50, y, 11, true, "Totals");
            d.text(320, y, 11, true, "Payment Mix");
            y += 16;
            let ty = y;
            const rows = [
                ["Sub Total", cur + money(z.subTotal)],
                ["Discounts", "- " + cur + money(z.discount)],
                ["CGST", cur + money(z.cgst)],
                ["SGST", cur + money(z.sgst)],
                ["IGST", cur + money(z.igst)],
                ["Round Off", cur + money(z.roundOff)],
                ["Grand Total", cur + money(z.grandTotal)],
                ["Refunds (" + z.refundCount + ")", "- " + cur + money(z.refundTotal)],
                ["Net Sales", cur + money(z.netSales)],
                ["Cash in Drawer", cur + money(z.cashInDrawer)],
                ["Invoice Range", (z.firstInvoiceNo == null ? "-" : z.firstInvoiceNo) + " to " + (z.lastInvoiceNo == null ? "-" : z.lastInvoiceNo)],
            ];
            for (const [label, value] of rows) {
                d.text(50, ty, 10.5, false, label);
                d.text(280 - d.textWidth(value, 10.5), ty, 10.5, false, value);
                ty += 14;
            }
            let py = y;
            for (const p of z.byPayment) {
                d.text(320, py, 10.5, false, p.mode + "  (" + p.count + ")");
                const amt = cur + money(p.amount);
                d.text(540 - d.textWidth(amt, 10.5), py, 10.5, false, amt);
                py += 14;
            }
            let bottomY = Math.max(ty, py) + 20;
            d.text(50, bottomY, 11, true, "Top Items (by revenue)");
            bottomY += 16;
            for (const t of z.topItems) {
                d.text(50, bottomY, 10.5, false, t.name);
                d.text(340, bottomY, 10.5, false, money(t.quantity) + (t.unit == null ? "" : " " + t.unit));
                const amt = cur + money(t.amount);
                d.text(540 - d.textWidth(amt, 10.5), bottomY, 10.5, false, amt);
                bottomY += 14;
            }
            this.bytes(res, 200, "application/pdf", d.toBytes(), "inline; filename=\"z-report-" + z.date + ".pdf\"");
        }

        // ---------------- backup & restore ----------------

        async backup(res, user) {
            requireRole(user, "ADMIN");
            const zip = await this.opts.Zip.create([
                { name: "freshmart.db", data: this.c.db.export() },
                { name: "store.properties", data: new TextEncoder().encode(this.c.store.text()) },
            ]);
            this.c.auditLog.log(user, "BACKUP_DOWNLOAD", zip.length + " bytes");
            this.bytes(res, 200, "application/zip", zip,
                "attachment; filename=\"freshmart-backup-" + this.c.clock.today() + ".zip\"");
        }

        /**
         * Phone flavour of SqliteRestore: same validation, but applied immediately - the PC has to
         * stage and restart because its database file is locked open; here the database is an
         * in-memory copy, so it is swapped and every service reloads from it on the spot. The
         * previous data is kept as a safety copy (see takeSafetyCopy) before anything changes.
         */
        async restore(res, user, raw) {
            requireRole(user, "ADMIN");
            const bytes = raw == null ? new Uint8Array(0)
                : raw instanceof Uint8Array ? raw : typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
            if (!bytes.length) throw bad("No backup file was received.");
            if (bytes.length > 256 * 1024 * 1024) throw bad("Upload too large (maximum 256 MB).");
            let entries;
            try { entries = await this.opts.Zip.read(bytes); } catch (e) { throw bad("That file is not a FreshMart backup zip."); }
            const dbBytes = entries.get("freshmart.db");
            if (!dbBytes) throw bad("That zip is not a FreshMart backup (no freshmart.db inside).");
            if (dbBytes.length < 16 || String.fromCharCode.apply(null, Array.from(dbBytes.subarray(0, 16))) !== SQLITE_MAGIC) {
                throw bad("The freshmart.db in that zip is not a valid SQLite database.");
            }
            let probe;
            try {
                probe = new this.opts.SQL.Database(dbBytes);
                const check = probe.exec("PRAGMA integrity_check");
                if (!check.length || String(check[0].values[0][0]).toLowerCase() !== "ok") {
                    throw bad("Backup database failed its integrity check.");
                }
                const tables = new Set((probe.exec("SELECT name FROM sqlite_master WHERE type='table'")[0] || { values: [] })
                    .values.map(v => String(v[0]).toLowerCase()));
                for (const t of REQUIRED_TABLES) {
                    if (!tables.has(t)) throw bad("That backup is missing the '" + t + "' table - it isn't a FreshMart backup.");
                }
            } catch (e) {
                if (e instanceof BadRequest) throw e;
                throw bad("Could not read that backup database: " + e.message);
            } finally {
                if (probe) probe.close();
            }
            const propsBytes = entries.get("store.properties");
            const propsText = propsBytes ? new TextDecoder().decode(propsBytes) : this.c.store.text();
            if (this.opts.takeSafetyCopy) {
                await this.opts.takeSafetyCopy({ db: this.c.db.export(), props: this.c.store.text() });
            }
            this.c.auditLog.log(user, "RESTORE_APPLIED", dbBytes.length + " byte database" + (propsBytes ? " + store.properties" : ""));
            const next = await Context.open(this.opts, dbBytes, propsText);
            this.c.db.sql.close();
            this.c = next;
            next.db.dirty = true;
            this.propsDirty = true;
            this.json(res, 200, {
                staged: false, restored: true,
                message: "Backup restored (" + dbBytes.length + " byte database" + (propsBytes ? " + store.properties" : "")
                    + "). Sign in with an account from that backup.",
            });
        }

        // ---------------- branch scoping ----------------

        branchId(user, q) {
            if (user.role !== "ADMIN") return user.branchId;
            const r = q.get("branchId");
            if (r == null || r === "" || eqIC(r, "all")) return this.c.branches.defaultBranchId();
            this.c.branches.require(r);
            return r;
        }
        branchIdForBody(user, r) {
            if (user.role !== "ADMIN") return user.branchId;
            if (r == null || r === "") return this.c.branches.defaultBranchId();
            this.c.branches.require(r);
            return r;
        }
        branchIdOrAll(user, q) {
            if (user.role !== "ADMIN") return user.branchId;
            const r = q.get("branchId");
            if (r == null || r === "" || eqIC(r, "all")) return null;
            this.c.branches.require(r);
            return r;
        }

        // ---------------- phone integration ----------------

        /** What to save after a request: null when nothing changed. */
        takeChanges() {
            const dbDirty = this.c.db.dirty;
            const propsDirty = this.propsDirty || this.c.store.dirty;
            if (!dbDirty && !propsDirty) return null;
            this.c.db.dirty = false;
            this.c.store.dirty = false;
            this.propsDirty = false;
            return { db: dbDirty ? this.c.db.export() : null, props: propsDirty ? this.c.store.text() : null };
        }
        sessionsSnapshot() { return this.c.sessions.snapshot(); }
        loadSessions(list) { this.c.sessions.load(list); }
        /** Test hook - the Java server prints this to the console on first run. */
        consumeBootstrapPassword() { const p = this.c.bootstrapPassword; this.c.bootstrapPassword = null; return p; }
    }

    function requireRole(user, ...allowed) {
        if (!allowed.includes(user.role)) throw forbidden("You do not have permission to do that.");
    }

    function branchFromDto(id, dto, active) {
        return {
            id: id == null ? null : id, name: oneLine(str(dto.name)), addressLine1: oneLine(str(dto.addressLine1)),
            addressLine2: oneLine(str(dto.addressLine2)), phone: oneLine(str(dto.phone)), gstin: oneLine(str(dto.gstin)),
            stateCode: oneLine(str(dto.stateCode)).toUpperCase(), active,
        };
    }

    /** ApiHandler.toItem */
    function toItem(dto, id, branchId) {
        if (dto == null) throw bad("Missing item data.");
        if (dto.name == null || jtrim(str(dto.name)) === "") throw bad("Item name is required.");
        const price = dbl(dto.price), tax = dbl(dto.taxRatePercent), stock = dbl(dto.stock), reorder = dbl(dto.reorderLevel);
        const cost = boxed(dto.costPrice);
        if (price < 0 || tax < 0 || stock < 0 || reorder < 0) throw bad("Price, GST %, stock and reorder level cannot be negative.");
        if (cost != null && cost < 0) throw bad("Cost price cannot be negative.");
        const slab = [0, 5, 12, 18, 28].find(s => Math.abs(tax - s) < 0.01);
        if (slab === undefined) throw bad("GST % must be one of 0, 5, 12, 18 or 28 (India's legal slabs).");
        const unit = dto.unit == null || jtrim(str(dto.unit)) === "" ? "pc" : oneLine(str(dto.unit));
        const category = dto.category == null || jtrim(str(dto.category)) === "" ? "General" : oneLine(str(dto.category));
        return {
            id: id == null ? null : oneLine(id), branchId, name: oneLine(str(dto.name)), category, unit, price: M.of(price),
            costPrice: cost == null ? 0 : M.of(cost), taxRatePercent: slab, stock, barcode: oneLine(str(dto.barcode)),
            reorderLevel: reorder,
        };
    }

    function sanitizeMoney(v, field) {
        if (!Number.isFinite(v)) throw bad(field + " must be a finite number.");
        if (v < 0 || v > 100000000) throw bad(field + " is out of range.");
        return v;
    }

    /** grocery.service.BillingService.checkout */
    function billingCheckout(c, branchId, cashier, customerName, customerPhone, paymentMode, discountD, paidD, requests, pos, branchState) {
        if (!requests.length) throw bad("The cart is empty - add at least one item.");
        const cart = [];
        for (const r of requests) {
            const item = c.inventory.findInBranch(branchId, r.itemId);
            if (!item) throw bad("Unknown item: " + r.itemId);
            if (r.quantity <= 0) throw bad("Quantity for '" + item.name + "' must be greater than zero.");
            cart.push({ item, quantity: r.quantity });
        }
        let subTotal = 0;
        const lines = cart.map(({ item, quantity }) => {
            const amount = M.times(item.price, quantity);
            subTotal += amount;
            return makeLine(item.id, item.name, item.unit, item.price, item.taxRatePercent, quantity, amount, M.taxOf(amount, item.taxRatePercent));
        });
        const discount = M.of(discountD);
        if (discount < 0) throw bad("Discount cannot be negative.");
        if (discount > subTotal) throw bad("Discount cannot be greater than the subtotal.");
        const name = customerName == null || jtrim(customerName) === "" ? "Walk-in Customer" : oneLine(customerName);
        const phone = oneLine(customerPhone);
        const mode = paymentMode == null || jtrim(paymentMode) === "" ? "Cash" : oneLine(paymentMode);
        const paid = paidD > 0 ? M.of(paidD) : null;
        let inv;
        c.db.inTransaction(() => {
            c.inventory.reserveStock(branchId, requests);
            inv = c.invoiceStore.createAndSave(branchId, cashier, name, phone, mode, lines, discount, paid, pos, branchState);
        });
        return inv;
    }

    function filterByDate(q, list) {
        const from = parseDate(q.get("from")), to = parseDate(q.get("to"));
        if (from == null && to == null) return list;
        return list.filter(x => {
            const day = x.dateTime.s.slice(0, 10);
            return !(from != null && day < from) && !(to != null && day > to);
        });
    }

    function paginate(list, q, mapper) {
        const total = list.length;
        let limit = parseIntOr(q.get("limit"), 50);
        if (limit < 1) limit = 1;
        if (limit > 1000) limit = 1000;
        let offset = parseIntOr(q.get("offset"), 0);
        if (offset < 0) offset = 0;
        if (offset > total) offset = total;
        const end = Math.min(offset + limit, total);
        return { items: list.slice(offset, end).map(mapper), total, offset, limit };
    }

    /** Top lines by revenue (dashboard: 5, Z-report: 10), keyed by item name like the Java code. */
    function topItems(invoices, n) {
        const by = new Map();
        for (const inv of invoices) {
            for (const l of inv.lines) {
                const a = by.get(l.name) || { name: l.name, quantity: 0, unit: l.unit, amount: 0 };
                a.quantity += l.quantity;
                a.amount += M.num(l.amount);
                by.set(l.name, a);
            }
        }
        return [...by.values()].sort((a, b) => dcmp(b.amount, a.amount)).slice(0, n);
    }

    function csvCell(s) {
        if (s == null) return "";
        if (!/[,"\n\r]/.test(s)) return s;
        return "\"" + s.replace(/"/g, "\"\"") + "\"";
    }

    /** The object FMPdf.invoicePdf / thermalPdf take (shape documented at the top of pdf.js). The PDF
     *  engine re-derives every total from the lines exactly as grocery.model.Invoice does, and decides
     *  CGST/SGST vs IGST from the same place-of-supply and branch state this invoice was built with. */
    function pdfInput(c, inv) {
        const store = {};
        for (const [k] of DEFAULT_STORE) store[k] = c.store.get(k);
        return {
            store,
            invoice: {
                invoiceNo: inv.invoiceNo, dateTime: inv.dateTime.s, cashierUsername: inv.cashierUsername,
                customerName: inv.customerName, customerPhone: inv.customerPhone, paymentMode: inv.paymentMode,
                discount: M.fmt(inv.discount), amountPaid: M.fmt(inv.amountPaid),
                placeOfSupplyStateCode: inv.placeOfSupplyStateCode, branchStateCode: inv.branchStateCode,
                lines: inv.lines.map(l => ({
                    itemId: l.itemId, name: l.name, unit: l.unit, price: M.fmt(l.price), taxRatePercent: l.taxRatePercent,
                    quantity: l.quantity, amount: M.fmt(l.amount), tax: M.fmt(l.tax),
                })),
            },
        };
    }

    // =====================================================================
    // public API
    // =====================================================================

    /**
     * opts: {
     *   SQL        - the initialised sql.js module (initSqlJs result)
     *   dbBytes    - Uint8Array of a saved database, or null on first launch
     *   propsText  - saved store.properties text, or null on first launch
     *   now()      - epoch ms (defaults to Date.now)
     *   random(n)  - n cryptographically random bytes (defaults to crypto.getRandomValues)
     *   Pdf, Zip, Props - FMPdf / FMZip / FMProps
     *   singleShop - true on the phone: one branch, shop details editable via PUT /api/store
     *   takeSafetyCopy({db, props}) - async; keeps the pre-restore data somewhere safe
     *   remoteIp, log
     * }
     */
    async function create(opts) {
        const o = Object.assign({
            now: () => Date.now(),
            random: n => root.crypto.getRandomValues(new Uint8Array(n)),
            Pdf: root.FMPdf, Zip: root.FMZip, Props: root.FMProps,
        }, opts);
        const ctx = await Context.open(o, o.dbBytes || null, o.propsText == null ? null : o.propsText);
        return new Backend(o, ctx);
    }

    const FMBackend = { create, _internal: { M, jd, trimNum, oneLine, parseQuery, makeInvoice } };
    root.FMBackend = FMBackend;
    if (typeof module !== "undefined" && module.exports) module.exports = FMBackend;
})(typeof globalThis !== "undefined" ? globalThis : this);
