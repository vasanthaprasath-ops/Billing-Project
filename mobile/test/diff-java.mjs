// Differential test: runs the same scripted session against the real Java server and the
// JavaScript port in mobile/src/backend.js, and fails on any difference in status code or
// response body. Run after changing billing rules on either side:
//
//     cd mobile && npm run test:diff
//
// Needs a JDK (javac/java on PATH). The Java server runs from a throwaway directory with a
// fresh database; the JS backend runs in-process on sql.js with a fresh database too.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const initSqlJs = require("sql.js");
const { FMZip, FMProps } = require("../src/zip.js");
const FMBackend = require("../src/backend.js");
const FMPdf = require("../src/pdf.js");

// ---------------------------------------------------------------- Java server

function compileJava() {
    const out = join(repo, "bin");
    mkdirSync(out, { recursive: true });
    const sources = [];
    const walk = d => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else if (p.endsWith(".java")) sources.push(p);
        }
    };
    walk(join(repo, "src"));
    const list = join(tmpdir(), "fm-diff-sources.txt");
    writeFileSync(list, sources.join("\n"));
    execFileSync("javac", ["-cp", join(repo, "lib") + "/*", "-d", out, "@" + list], { stdio: "inherit" });
    return out;
}

async function startJava(bin) {
    const cwd = mkdtempSync(join(tmpdir(), "fm-diff-java-"));
    const port = 18000 + Math.floor(Math.random() * 2000);
    const proc = spawn("java", ["-Djava.awt.headless=true", "-cp", bin + ":" + join(repo, "lib") + "/*", "grocery.Main", String(port)],
        { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const password = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Java server did not start:\n" + log)), 60000);
        const onData = d => {
            log += d;
            const m = /Password:\s*(\S+)/.exec(log);
            if (m && log.includes("http://localhost:" + port)) { clearTimeout(t); resolve(m[1]); }
        };
        proc.stdout.on("data", onData);
        proc.stderr.on("data", onData);
        proc.on("exit", code => reject(new Error("Java server exited (" + code + "):\n" + log)));
    });
    const base = "http://127.0.0.1:" + port;
    return {
        password,
        async call(method, path, body, sid) {
            const headers = {};
            if (sid) headers.Cookie = "sid=" + sid;
            let payload;
            if (body instanceof Uint8Array) { payload = body; headers["Content-Type"] = "application/octet-stream"; }
            else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
            const r = await fetch(base + path, { method, headers, body: payload });
            const setCookie = r.headers.get("set-cookie");
            const m = setCookie && /sid=([^;]*)/.exec(setCookie);
            const ct = r.headers.get("content-type") || "";
            const raw = new Uint8Array(await r.arrayBuffer());
            return { status: r.status, contentType: ct, raw, setSid: m ? m[1] : undefined };
        },
        stop() { proc.kill(); rmSync(cwd, { recursive: true, force: true }); },
    };
}

// ---------------------------------------------------------------- JS backend

async function startJs() {
    const SQL = await initSqlJs();
    const backend = await FMBackend.create({ SQL, Zip: FMZip, Props: FMProps, Pdf: FMPdf, singleShop: false });
    return {
        password: backend.consumeBootstrapPassword(),
        async call(method, path, body, sid) {
            const [p, query] = path.split("?");
            const payload = body instanceof Uint8Array ? body : body === undefined ? null : JSON.stringify(body);
            const r = await backend.handle({ method, path: p, query: query || "", sid, body: payload });
            const raw = typeof r.body === "string" ? new TextEncoder().encode(r.body) : (r.body || new Uint8Array(0));
            return { status: r.status, contentType: r.contentType, raw, setSid: r.setSid };
        },
        stop() {},
    };
}

// ---------------------------------------------------------------- comparison

const DT = /\b\d{2}-\d{2}-\d{4} \d{2}:\d{2}(:\d{2})?\b/g;
function normalise(value) {
    if (typeof value === "string") {
        return value.replace(DT, "<datetime>").replace(/ref: [0-9a-z-]+/gi, "ref: <id>")
            .replace(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/, "<recovery code>");
    }
    if (Array.isArray(value)) return value.map(normalise);
    if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = normalise(value[k]);
        return out;
    }
    return value;
}
function decodeBody(res) {
    if (res.contentType.includes("pdf")) {
        // Byte-for-byte except the printed time of day (the two servers bill a few ms apart and
        // may straddle a minute) and the xref offsets that shift with it.
        const latin1 = Array.from(res.raw, b => String.fromCharCode(b)).join("");
        return latin1.replace(/\d{1,2}:\d{2}( ?[AaPp][Mm])?/g, "<time>").replace(/xref[\s\S]*$/, "xref");
    }
    const text = new TextDecoder().decode(res.raw);
    if (res.contentType.includes("json")) {
        try { return JSON.parse(text); } catch (e) { return text; }
    }
    return text;
}
function firstDiff(a, b, path = "") {
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return { path, java: a, js: b };
    if (Array.isArray(a)) {
        if (a.length !== b.length) return { path: path + ".length", java: a.length, js: b.length };
        for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], path + "[" + i + "]"); if (d) return d; }
        return null;
    }
    if (a && typeof a === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) { const d = firstDiff(a[k], b[k], path + "." + k); if (d) return d; }
        return null;
    }
    return Object.is(a, b) || a === b ? null : { path, java: a, js: b };
}

// ---------------------------------------------------------------- the script

const today = () => {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
    return f.format(new Date());
};

function scenario(t) {
    const D = today();
    const y = new Date(Date.parse(D + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    const weekAgo = new Date(Date.parse(D + "T00:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
    return [
        // --- public + auth gate
        ["store (public)", null, "GET", "/api/store"],
        ["items without session", null, "GET", "/api/items"],
        ["login wrong password", null, "POST", "/api/auth/login", { username: "admin", password: "nope" }],
        ["login missing fields", null, "POST", "/api/auth/login", { username: "admin" }],
        ["login admin (bootstrap)", "admin", "POST", "/api/auth/login", { username: "admin", password: t.bootstrap }, "admin"],
        ["must-change gate", "admin", "GET", "/api/items"],
        ["me while must-change", "admin", "GET", "/api/auth/me"],
        ["change pw too short", "admin", "POST", "/api/auth/change-password", { newPassword: "abc" }],
        ["change pw", "admin", "POST", "/api/auth/change-password", { newPassword: "Admin@123" }, "admin"],
        ["me", "admin", "GET", "/api/auth/me"],
        ["unknown endpoint", "admin", "GET", "/api/nope"],
        // --- branches
        ["branches", "admin", "GET", "/api/branches"],
        ["branch set state TN", "admin", "PUT", "/api/branches/BR-001", { name: "FreshMart Grocery Store", addressLine1: "No. 12, Market Road, T. Nagar", addressLine2: "Chennai - 600017, Tamil Nadu", phone: "+91 98765 43210", gstin: "33ABCDE1234F1Z5", stateCode: "tn", active: true }],
        ["branch name missing", "admin", "POST", "/api/branches", { name: "  " }],
        ["branch add + clone", "admin", "POST", "/api/branches", { name: "Anna Nagar\nBranch", addressLine1: "2nd Ave", stateCode: "tn", cloneFromBranchId: "BR-001" }],
        ["branch clone unknown", "admin", "POST", "/api/branches", { name: "Bad", cloneFromBranchId: "BR-999" }],
        ["branches after add", "admin", "GET", "/api/branches"],
        // --- users
        ["user add manager", "admin", "POST", "/api/users", { username: "manager1", password: "manager1", fullName: "Meena", role: "manager", branchId: "BR-001" }],
        ["user add cashier", "admin", "POST", "/api/users", { username: "cash1", password: "cashier1", fullName: "Ravi", role: "CASHIER", branchId: "BR-001" }],
        ["user add cashier br2", "admin", "POST", "/api/users", { username: "cash2", password: "cashier2", fullName: "Anu", role: "CASHIER", branchId: "BR-002" }],
        ["user add duplicate", "admin", "POST", "/api/users", { username: "CASH1", password: "cashier1", role: "CASHIER", branchId: "BR-001" }],
        ["user add no branch", "admin", "POST", "/api/users", { username: "x1", password: "xxxxxx", role: "CASHIER" }],
        ["user add short pw", "admin", "POST", "/api/users", { username: "x2", password: "123", role: "ADMIN" }],
        ["user add bad role -> cashier", "admin", "POST", "/api/users", { username: "x3", password: "xxxxxx", role: "boss", branchId: "BR-002" }],
        ["users", "admin", "GET", "/api/users"],
        ["user demote self", "admin", "PUT", "/api/users/admin", { role: "MANAGER", branchId: "BR-001", active: true }],
        ["user deactivate self", "admin", "PUT", "/api/users/admin", { role: "ADMIN", active: false }],
        ["user update unknown", "admin", "PUT", "/api/users/ghost", { role: "ADMIN", active: true }],
        ["user update x3", "admin", "PUT", "/api/users/x3", { fullName: "Xavier", role: "CASHIER", branchId: "BR-002", active: false }],
        // --- staff sign-in
        ["manager login", "manager1", "POST", "/api/auth/login", { username: "manager1", password: "manager1" }, "manager1"],
        ["manager change pw", "manager1", "POST", "/api/auth/change-password", { newPassword: "Manager@1" }, "manager1"],
        ["cashier login", "cash1", "POST", "/api/auth/login", { username: "cash1", password: "cashier1" }, "cash1"],
        ["cashier change pw", "cash1", "POST", "/api/auth/change-password", { newPassword: "Cashier@1" }, "cash1"],
        ["cashier2 login", "cash2", "POST", "/api/auth/login", { username: "cash2", password: "cashier2" }, "cash2"],
        ["cashier2 change pw", "cash2", "POST", "/api/auth/change-password", { newPassword: "Cashier@2" }, "cash2"],
        ["inactive user login", null, "POST", "/api/auth/login", { username: "x3", password: "xxxxxx" }],
        ["cashier branches forbidden", "cash1", "GET", "/api/branches"],
        ["cashier add item forbidden", "cash1", "POST", "/api/items", { name: "X", price: 1 }],
        // --- items
        ["items br1", "admin", "GET", "/api/items?branchId=BR-001"],
        ["items br2 (clone)", "admin", "GET", "/api/items?branchId=br-002"],
        ["items unknown branch", "admin", "GET", "/api/items?branchId=BR-404"],
        ["items search", "admin", "GET", "/api/items?q=%20OIL%20"],
        ["items search category", "cash1", "GET", "/api/items?q=dairy"],
        ["items barcode", "cash1", "GET", "/api/items?barcode=8901000000031"],
        ["items barcode by id", "cash1", "GET", "/api/items?barcode=itm-005"],
        ["items barcode miss", "cash1", "GET", "/api/items?barcode=1"],
        ["items page", "manager1", "GET", "/api/items?limit=7&offset=40"],
        ["items page clamp", "manager1", "GET", "/api/items?limit=0&offset=-5"],
        ["item invalid GST", "manager1", "POST", "/api/items", { name: "Odd", price: 10, taxRatePercent: 7 }],
        ["item negative price", "manager1", "POST", "/api/items", { name: "Neg", price: -1 }],
        ["item negative cost", "manager1", "POST", "/api/items", { name: "Neg", price: 1, costPrice: -1 }],
        ["item missing name", "manager1", "POST", "/api/items", { price: 5 }],
        ["item add fractional", "manager1", "POST", "/api/items", { id: "", name: " Cashew\r\nNuts 250g ", category: "", unit: "", price: 12.345, costPrice: 8.125, taxRatePercent: 18.001, stock: 10.5, reorderLevel: 2, barcode: " 999 " }],
        ["item add odd paise", "manager1", "POST", "/api/items", { id: "SKU-A1", name: "Paneer 200g", category: "Dairy", unit: "pkt", price: 33.33, costPrice: 25, taxRatePercent: 5, stock: 40, reorderLevel: 5 }],
        ["item add tiny tax", "manager1", "POST", "/api/items", { id: "SKU-A2", name: "Toffee", category: "Snacks", unit: "pc", price: 0.5, taxRatePercent: 5, stock: 500, reorderLevel: 20 }],
        ["item add duplicate id", "manager1", "POST", "/api/items", { id: "sku-a1", name: "Dup", price: 1 }],
        ["item update price, omit cost", "manager1", "PUT", "/api/items/ITM-003", { name: "Sunflower Oil 1L", category: "Oils", unit: "ltr", price: 170, taxRatePercent: 5, stock: 1, barcode: "8901000000031", reorderLevel: 10 }],
        ["item update set cost", "manager1", "PUT", "/api/items/ITM-001", { name: "Basmati Rice 1kg", category: "Grains", unit: "pkt", price: 120, costPrice: 95.5, taxRatePercent: 5, barcode: "8901000000017", reorderLevel: 10 }],
        ["item update wrong branch", "cash2", "PUT", "/api/items/ITM-001", { name: "x", price: 1 }],
        ["item update other branch as admin", "admin", "PUT", "/api/items/ITM-001", { branchId: "BR-002", name: "x", price: 1 }],
        ["adjust +delta", "manager1", "POST", "/api/items/ITM-097/adjust-stock", { delta: 5.25, reason: " delivery " }],
        ["adjust newStock", "manager1", "POST", "/api/items/ITM-003/adjust-stock", { newStock: 3 }],
        ["adjust below zero", "manager1", "POST", "/api/items/ITM-003/adjust-stock", { delta: -100 }],
        ["adjust neither", "manager1", "POST", "/api/items/ITM-003/adjust-stock", { reason: "x" }],
        ["adjust unknown", "manager1", "POST", "/api/items/ITM-999/adjust-stock", { delta: 1 }],
        ["adjust zero", "manager1", "POST", "/api/items/ITM-002/adjust-stock", { delta: 0 }],
        ["delete item", "manager1", "DELETE", "/api/items/ITM-048"],
        ["delete missing item", "manager1", "DELETE", "/api/items/ITM-777"],
        ["cost price for profit", "manager1", "PUT", "/api/items/ITM-019", { name: "Onion 1kg", category: "Vegetables", unit: "kg", price: 40, costPrice: 30, taxRatePercent: 0, barcode: "8901000000192", reorderLevel: 10 }],
        // --- checkout
        ["checkout empty cart", "cash1", "POST", "/api/checkout", { lines: [] }],
        ["checkout no body lines", "cash1", "POST", "/api/checkout", {}],
        ["checkout unknown item", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-999", quantity: 1 }] }],
        ["checkout zero qty", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-001", quantity: 0 }] }],
        ["checkout negative qty", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-001", quantity: -1 }] }],
        ["checkout huge qty", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-001", quantity: 2000000 }] }],
        ["checkout discount > sub", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-014", quantity: 1 }], discount: 25 }],
        ["checkout negative discount", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-014", quantity: 1 }], discount: -1 }],
        ["checkout short stock", "cash1", "POST", "/api/checkout", { lines: [{ itemId: "ITM-003", quantity: 2 }, { itemId: "ITM-003", quantity: 2 }] }],
        ["checkout cash + change", "cash1", "POST", "/api/checkout", { customerName: "  Priya\nS ", customerPhone: " 98400 11111 ", paymentMode: "Cash", discount: 10.555, amountPaid: 1000, lines: [{ itemId: "ITM-001", quantity: 2 }, { itemId: "ITM-011", quantity: 1 }, { itemId: "SKU-A1", quantity: 3 }] }],
        ["checkout fractional qty UPI", "cash1", "POST", "/api/checkout", { customerName: "Priya S", customerPhone: "98400 11111", paymentMode: "UPI", lines: [{ itemId: "ITM-019", quantity: 0.75 }, { itemId: "ITM-023", quantity: 1.333 }, { itemId: "SKU-A2", quantity: 7 }] }],
        ["checkout underpaid -> exact", "cash1", "POST", "/api/checkout", { paymentMode: "", amountPaid: 5, lines: [{ itemId: "ITM-045", quantity: 3 }, { itemId: "ITM-045", quantity: 1 }] }],
        ["checkout IGST", "manager1", "POST", "/api/checkout", { customerName: "Kumar Traders", customerPhone: "080 2222", paymentMode: "Card", placeOfSupplyStateCode: " ka ", lines: [{ itemId: "ITM-015", quantity: 2 }, { itemId: "ITM-097", quantity: 1.5 }] }],
        ["checkout same state", "manager1", "POST", "/api/checkout", { customerName: "Walk-in Customer", placeOfSupplyStateCode: "TN", lines: [{ itemId: "ITM-012", quantity: 1 }] }],
        ["checkout cashier pinned", "cash1", "POST", "/api/checkout", { branchId: "BR-002", lines: [{ itemId: "ITM-005", quantity: 1 }] }],
        ["checkout br2 item from br1 cashier", "cash2", "POST", "/api/checkout", { lines: [{ itemId: "ITM-005", quantity: 1 }] }],
        ["checkout br2 (no stock)", "cash2", "POST", "/api/checkout", { lines: [{ itemId: "ITM-050", quantity: 1 }] }],
        ["admin restock br2", "admin", "POST", "/api/items/ITM-050/adjust-stock", { branchId: "BR-002", delta: 20 }],
        ["checkout br2", "cash2", "POST", "/api/checkout", { customerName: "anna", paymentMode: "Cash", amountPaid: 200, lines: [{ itemId: "ITM-050", quantity: 2 }] }],
        ["checkout admin default branch", "admin", "POST", "/api/checkout", { customerPhone: "98400 11111", lines: [{ itemId: "ITM-020", quantity: 2.5 }] }],
        ["checkout rounding", "cash1", "POST", "/api/checkout", { customerName: "Walk-in customer", lines: [{ itemId: "ITM-013", quantity: 1 }, { itemId: "ITM-007", quantity: 1 }, { itemId: "SKU-A2", quantity: 1 }], discount: 0.49 }],
        // --- invoices
        ["invoices all", "admin", "GET", "/api/invoices"],
        ["invoices br1", "admin", "GET", "/api/invoices?branchId=BR-001"],
        ["invoices page", "admin", "GET", "/api/invoices?branchId=all&limit=3&offset=2"],
        ["invoices today", "cash1", "GET", `/api/invoices?from=${D}&to=${D}`],
        ["invoices yesterday", "cash1", "GET", `/api/invoices?from=${y}&to=${y}`],
        ["invoices bad date", "cash1", "GET", "/api/invoices?from=2026-02-30"],
        ["invoice detail", "cash1", "GET", "/api/invoices/inv-1001"],
        ["invoice not found", "cash1", "GET", "/api/invoices/INV-9999"],
        ["invoice other branch", "cash2", "GET", "/api/invoices/INV-1001"],
        ["invoices csv", "admin", "GET", `/api/invoices.csv?from=${D}`],
        ["invoices csv cashier", "cash1", "GET", "/api/invoices.csv"],
        // --- refunds
        ["refundable", "manager1", "GET", "/api/invoices/INV-1003/refundable"],
        ["refund by cashier", "cash1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001", lines: [{ itemId: "ITM-001", quantity: 1 }] }],
        ["refund no invoice", "manager1", "POST", "/api/refunds", { lines: [] }],
        ["refund none picked", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001" }],
        ["refund zeros", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001", lines: [{ itemId: "ITM-001", quantity: 0 }] }],
        ["refund not on bill", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001", lines: [{ itemId: "ITM-002", quantity: 1 }] }],
        ["refund too many", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001", lines: [{ itemId: "ITM-001", quantity: 3 }] }],
        ["refund partial", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001", reason: "damaged", lines: [{ itemId: "ITM-001", quantity: 1 }, { itemId: "SKU-A1", quantity: 1.5 }] }],
        ["refund dup lines summed", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1003", lines: [{ itemId: "ITM-045", quantity: 2 }, { itemId: "ITM-045", quantity: 2 }] }],
        ["refund merged original", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1003", lines: [{ itemId: "ITM-045", quantity: 4 }] }],
        ["refund remaining", "manager1", "POST", "/api/refunds", { originalInvoiceNo: "INV-1001", lines: [{ itemId: "ITM-001", quantity: 1.0000000001 }, { itemId: "SKU-A1", quantity: 1.5 }] }],
        ["refundable after", "manager1", "GET", "/api/invoices/INV-1001/refundable"],
        ["refund other branch", "cash2", "GET", "/api/refunds/RFD-1001"],
        ["refunds", "admin", "GET", "/api/refunds"],
        ["refunds page", "manager1", "GET", "/api/refunds?limit=1&offset=1"],
        ["refund detail", "manager1", "GET", "/api/refunds/rfd-1002"],
        ["refund missing", "manager1", "GET", "/api/refunds/RFD-9"],
        // --- customers
        ["customers", "admin", "GET", "/api/customers"],
        ["customers q", "cash1", "GET", "/api/customers?q=PRI"],
        ["customers page", "admin", "GET", "/api/customers?limit=1"],
        ["customer history phone", "cash1", "GET", "/api/customers/history?phone=98400%2011111"],
        ["customer history name", "admin", "GET", "/api/customers/history?name=KUMAR%20TRADERS"],
        ["customer history none", "cash1", "GET", "/api/customers/history"],
        // --- reports
        ["dashboard all", "admin", "GET", "/api/dashboard"],
        ["dashboard br1 today", "admin", "GET", `/api/dashboard?branchId=BR-001&from=${D}&to=${D}`],
        ["dashboard week", "manager1", "GET", `/api/dashboard?from=${weekAgo}&to=${D}`],
        ["dashboard cashier", "cash2", "GET", "/api/dashboard"],
        ["dashboard bad range", "admin", "GET", `/api/dashboard?from=${D}&to=${y}`],
        ["z report", "admin", "GET", "/api/reports/z"],
        ["z report br1", "manager1", "GET", `/api/reports/z?date=${D}`],
        ["z report yesterday", "cash1", "GET", `/api/reports/z?date=${y}`],
        ["z report bad date", "cash2", "GET", "/api/reports/z?date=today"],
        // --- forgot username / forgot password
        ["accounts (public)", null, "GET", "/api/auth/accounts"],
        ["me: no recovery code yet", "admin", "GET", "/api/auth/me"],
        ["recovery code: wrong password", "admin", "POST", "/api/auth/recovery-code", { currentPassword: "nope" }],
        ["recovery code: cashier refused", "cash1", "POST", "/api/auth/recovery-code", { currentPassword: "Cashier@1" }],
        ["recovery code", "admin", "POST", "/api/auth/recovery-code", { currentPassword: "Admin@123" }],
        ["me: has recovery code", "admin", "GET", "/api/auth/me"],
        ["recover: missing fields", null, "POST", "/api/auth/recover", { username: "admin" }],
        ["recover: short password", null, "POST", "/api/auth/recover", { username: "admin", recoveryCode: "x", newPassword: "1" }],
        ["recover: wrong code", null, "POST", "/api/auth/recover", { username: "admin", recoveryCode: "AAAA-AAAA-AAAA-AAAA", newPassword: "Whatever1" }],
        ["recover: staff have no code", null, "POST", "/api/auth/recover", { username: "manager1", recoveryCode: "__RC__", newPassword: "Whatever1" }],
        ["recover: unknown user", null, "POST", "/api/auth/recover", { username: "ghost", recoveryCode: "__RC__", newPassword: "Whatever1" }],
        ["recover ok (lowercase, no dashes)", "admin", "POST", "/api/auth/recover", { username: "ADMIN", recoveryCode: "__RC_LOOSE__", newPassword: "Admin@123" }, "admin"],
        ["recover: old code used up", null, "POST", "/api/auth/recover", { username: "admin", recoveryCode: "__RC_OLD__", newPassword: "Whatever1" }],
        ["me after recover", "admin", "GET", "/api/auth/me"],
        // --- password reset, lockout, logout
        ["admin resets cashier pw", "admin", "PUT", "/api/users/cash1", { fullName: "Ravi K", role: "CASHIER", branchId: "BR-001", active: true, password: "reset99" }],
        ["reset user old session", "cash1", "GET", "/api/items"],
        ["reset pw too short", "admin", "PUT", "/api/users/cash2", { role: "CASHIER", branchId: "BR-002", active: true, password: "123" }],
        ["lockout 1", null, "POST", "/api/auth/login", { username: "Manager1 ", password: "bad" }],
        ["lockout 2", null, "POST", "/api/auth/login", { username: "manager1", password: "bad" }],
        ["lockout 3", null, "POST", "/api/auth/login", { username: "manager1", password: "bad" }],
        ["lockout 4", null, "POST", "/api/auth/login", { username: "manager1", password: "bad" }],
        ["lockout 5", null, "POST", "/api/auth/login", { username: "manager1", password: "bad" }],
        ["lockout 6 (locked)", null, "POST", "/api/auth/login", { username: "manager1", password: "Manager@1" }],
        ["logout", "manager1", "POST", "/api/auth/logout"],
        ["after logout", "manager1", "GET", "/api/items"],
        ["pdf A4 cash", "admin", "GET", "/api/invoices/INV-1001/pdf"],
        ["pdf thermal cash", "admin", "GET", "/api/invoices/INV-1001/pdf?format=thermal"],
        ["pdf A4 IGST", "admin", "GET", "/api/invoices/INV-1004/pdf"],
        ["pdf thermal fractional", "admin", "GET", "/api/invoices/INV-1002/pdf?format=THERMAL"],
        ["pdf other branch", "cash2", "GET", "/api/invoices/INV-1001/pdf"],
        ["z report pdf", "admin", "GET", `/api/reports/z.pdf?date=${D}`],
        ["z report pdf br2", "cash2", "GET", "/api/reports/z.pdf"],
        ["audit log", "admin", "GET", "/api/audit-log?limit=200"],
        ["audit log br1", "admin", "GET", "/api/audit-log?branchId=BR-001"],
    ];
}

// ---------------------------------------------------------------- run

const bin = compileJava();
const java = await startJava(bin);
const js = await startJs();
const sessions = { java: {}, js: {} };
const codes = { java: [], js: [] };   // recovery codes each side issued, newest last
const fillCodes = (v, side) => {
    if (typeof v === "string") {
        const list = codes[side];
        if (v === "__RC__") return list[list.length - 1] || "";
        if (v === "__RC_LOOSE__") return (list[list.length - 1] || "").toLowerCase().replace(/-/g, "");
        if (v === "__RC_OLD__") return list[list.length - 2] || "";
        return v;
    }
    if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
        const o = Array.isArray(v) ? [] : {};
        for (const k of Object.keys(v)) o[k] = fillCodes(v[k], side);
        return o;
    }
    return v;
};
let failures = 0, count = 0;
try {
    const steps = scenario({ bootstrap: "__BOOTSTRAP__" });
    for (const [label, who, method, path, body, keepSessionFor] of steps) {
        count++;
        const run = async (side, impl) => {
            let b = fillCodes(body, side);
            if (b && b.password === "__BOOTSTRAP__") b = { ...b, password: impl.password };
            const res = await impl.call(method, path, b, who ? sessions[side][who] : undefined);
            if (keepSessionFor && res.setSid) sessions[side][keepSessionFor] = res.setSid;
            try {
                const j = JSON.parse(new TextDecoder().decode(res.raw));
                if (j && j.recoveryCode) codes[side].push(j.recoveryCode);
            } catch (e) { /* not JSON */ }
            return res;
        };
        const a = await run("java", java);
        const b = await run("js", js);
        const na = normalise(decodeBody(a)), nb = normalise(decodeBody(b));
        const diff = a.status !== b.status ? { path: "(status)", java: a.status, js: b.status } : firstDiff(na, nb);
        if (diff) {
            failures++;
            console.log(`FAIL  ${label}: ${method} ${path}`);
            console.log(`      at ${diff.path}: java=${JSON.stringify(diff.java)} js=${JSON.stringify(diff.js)}`);
        } else {
            const brief = process.env.VERBOSE ? "  " + new TextDecoder().decode(a.raw).slice(0, 160) : "";
            console.log(`ok    ${label}  [${a.status}]${brief}`);
        }
    }

    // Backups travel both ways: a PC backup restores on the phone with every invoice intact,
    // and a phone backup passes the PC's restore validation.
    const check = (label, ok, detail) => {
        count++;
        if (ok) console.log(`ok    ${label}`);
        else { failures++; console.log(`FAIL  ${label}: ${detail}`); }
    };
    const pcBackup = await java.call("GET", "/api/admin/backup", undefined, sessions.java.admin);
    const phone = await FMBackend.create({ SQL: await initSqlJs(), Zip: FMZip, Props: FMProps, Pdf: FMPdf, singleShop: true });
    const phoneLogin = await phone.handle({ method: "POST", path: "/api/auth/login", body: JSON.stringify({ username: "admin", password: phone.consumeBootstrapPassword() }) });
    const phoneReady = await phone.handle({ method: "POST", path: "/api/auth/change-password", sid: phoneLogin.setSid, body: JSON.stringify({ newPassword: "Phone@123" }) });
    const restored = await phone.handle({ method: "POST", path: "/api/admin/restore", sid: phoneReady.setSid, body: pcBackup.raw });
    check("PC backup restores on phone", restored.status === 200, restored.body);
    const relogin = await phone.handle({ method: "POST", path: "/api/auth/login", body: JSON.stringify({ username: "admin", password: "Admin@123" }) });
    check("PC password works on phone", relogin.status === 200, relogin.body);
    const pcInvoices = normalise(decodeBody(await java.call("GET", "/api/invoices", undefined, sessions.java.admin)));
    const phoneInvoices = await phone.handle({ method: "GET", path: "/api/invoices", sid: relogin.setSid });
    // Sorted by number: the test bills everything within a second or two, and a restored database
    // keeps whole seconds only, so same-second bills can list in a different order (a restarted
    // Java server orders them the same way the phone does).
    const byNo = list => list.slice().sort((a, b) => (a.invoiceNo < b.invoiceNo ? -1 : 1));
    const d = firstDiff(byNo(pcInvoices), byNo(normalise(JSON.parse(phoneInvoices.body))));
    check("PC invoices identical after restore", !d, JSON.stringify(d));
    const phoneBackup = await phone.handle({ method: "GET", path: "/api/admin/backup", sid: relogin.setSid });
    const staged = await java.call("POST", "/api/admin/restore", phoneBackup.body, sessions.java.admin);
    check("phone backup accepted by PC restore", staged.status === 200, new TextDecoder().decode(staged.raw));
} finally {
    java.stop();
    js.stop();
}
console.log(`\n${count - failures}/${count} steps identical`);
process.exit(failures ? 1 : 0);
