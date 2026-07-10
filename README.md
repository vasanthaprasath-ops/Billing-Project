# FreshMart — Grocery Store Billing System (Web App)

A complete, ready-to-run **multi-branch grocery store point-of-sale & billing web
application**, with sign-in, roles, barcode scanning, thermal receipts and an audit trail —
built for more than one till.

- **Backend:** pure **Java (JDK 17)** using the JDK's built-in HTTP server, with a single
  vendored library (**Gson**, in `lib/`) for JSON. Includes a **hand-written PDF engine**
  that produces real tax-invoice PDFs — no iText/PDFBox needed. Password hashing, session
  cookies and zip backups all use the JDK's own `javax.crypto` / `java.util.zip` — no new
  dependencies were added for any of this.
- **Frontend:** an interactive single-page web UI (HTML / CSS / vanilla JavaScript) — no
  framework, no build step, nothing loaded from the internet at runtime.
- **Storage:** human-readable CSV files under `data/` — no database server. Every write is
  now crash-safe (write-to-temp-then-rename) and checkout is fully atomic, so two tills
  ringing up the same item at the same moment can never oversell it or collide on an
  invoice number.

You run one command, your browser opens, and you have a working store — or a working
chain of stores.

---

## Features

### 🔐 Sign-in, roles & branches
- Every screen requires signing in. First run creates an **admin** account with a random
  password printed once to the console — you're asked to set your own on first sign-in.
- Three roles: **Admin** (everything, every branch), **Manager** (full run of their one
  branch), **Cashier** (billing + viewing invoices in their branch only, no catalogue edits).
- **Multiple branches**, each with its own catalogue, stock and invoices. Admins get a
  branch switcher (with an "All Branches" aggregated view); Managers and Cashiers are
  pinned to their assigned branch, server-side — a spoofed branch id in a request is
  simply ignored.
- Adding a branch can **clone an existing branch's catalogue** (same products/prices,
  stock reset to zero) so a new store isn't set up from scratch.

### 🧾 Billing / Point of Sale
- Searchable product grid — click to add items to the bill.
- **Barcode scan bar**: plug in any USB/Bluetooth barcode scanner (it just types + Enter,
  no drivers needed) or type an item's ID/SKU directly.
- Live cart with quantity steppers, per-line amounts, and **instant totals**.
- Customer name & phone, payment mode (Cash / Card / UPI), and discount.
- **Cash tendered → change due**: for cash sales a "Cash Tendered" field appears; the
  screen shows live **Change Due** (or "Short by" if under-paid), the receipt prints the
  change, and the success screen calls it out so the cashier hands back the right notes.
  Card / UPI hide the field entirely.
- **GST** calculated per item and split into CGST + SGST.
- One click generates **both** a full **A4 tax invoice PDF** and a narrow **80mm thermal
  receipt PDF**, either of which opens in a new tab ready to print.

### 📦 Products / Inventory
- Add, edit and delete products (price, unit, GST %, stock, barcode, reorder alert level)
  via a clean modal form — scoped to whichever branch is selected.
- Stock **auto-decrements atomically** on each sale; concurrent checkouts on the same item
  can never both succeed if there isn't enough stock for both.
- Per-item reorder threshold drives the dashboard's low-stock alerts (a case of rice and a
  pack of chewing gum don't need the same "running low" line).
- Ships with 23 realistic sample grocery products per branch.

### 📁 Invoices
- Browse every past sale, search by invoice number, customer or cashier, and reopen the
  **A4 invoice or thermal receipt** PDF for any of them.
- The same **reporting-period switch** filters the list by date and shows the total takings
  for the selected window right in the toolbar.
- Admins viewing "All Branches" see which branch and which cashier rang up each sale.

### ↩️ Returns / Refunds
- One click on any invoice's **↩ Return** button opens a modal that shows every line
  from the bill with three columns: sold, already-refunded, remaining. Enter the quantity
  to return per line (client clamps to what's left) and the refund total appears live.
- The server independently enforces per-line remaining quantity — an attempt to over-refund
  is rejected with the exact line and quantity that failed, so two tills cannot both
  refund the last piece of an item at the same moment.
- Stock is put back on the shelf atomically as part of the refund (same monitor as
  checkout — a refund can never race an in-flight sale).
- Refunds get their own **RFD-####** numbers and live in a separate "Returns" tab under
  Invoices; every refund lands in the audit log with `REFUND` and the amount.
- Dashboard flips to **Net Sales** (gross − refunds) as soon as any refund exists in the
  period; the Z-report has a Refunds line and reduces Cash-in-Drawer by the payout.

### 📊 Dashboard
- Total sales, invoice count, product count and low-stock alerts at a glance, scoped to
  the selected branch — or, for admins, aggregated across every branch with a
  **Sales by Branch** breakdown.
- A **reporting-period switch** (Today / last 7 days / this month / all time) scopes every
  sales figure — the number a store actually reconciles against at day-end. Product count
  and low-stock alerts always reflect *current* inventory, not the chosen window.
- A **Revenue-by-Category** bar chart and a list of recent invoices.

### ⚙️ Admin
- **Branches** — add, edit, activate/deactivate, clone a catalogue into a new branch.
- **Users** — create Admin/Manager/Cashier accounts, assign them to a branch, reset a
  password (forces the user to choose a new one on next sign-in), deactivate an account.
- **Day-End Z-Report** — the day's reconciliation on one screen: total sales, cash-in-drawer,
  CGST + SGST collected, first/last invoice numbers, payment-mode breakdown and top-selling
  items. Pick any date and any branch (or all combined), then hit Print for a clean printable
  page the accountant can file.
- **Audit Log** — an append-only trail of logins, price changes, stock edits, checkouts,
  user/branch changes and backups: who did what, and when.
- **Backup** — download a zip of every CSV in `data/` on demand. The app also takes its own
  dated copy under `data/backups/` once a day automatically, since these CSV files are the
  entire database.

### 🔒 Correct & safe by design
- All money uses `BigDecimal` (never floating point) so totals are always exact.
- The server **re-prices every line from its own catalogue** at checkout, so a tampered
  client price can never change a bill.
- Passwords are hashed with salted PBKDF2 (120k iterations); sessions are opaque random
  tokens in an HttpOnly cookie, never JWTs or anything a client could forge or decode.
- **Brute-force protection**: after 5 failed sign-in attempts against the same username
  inside 15 minutes, that account is locked out for 15 minutes and every attempt is logged
  to the audit trail — other accounts on the same till carry on unaffected.
- Every non-admin request is scoped to the signed-in user's own branch **on the server**,
  regardless of what the client asks for.

---

## Requirements

- **JDK 17 or newer** (`java` and `javac` on your `PATH`). Check with `java -version`.
- A web browser.

No Maven/Gradle, no internet at runtime, no database. The one dependency (Gson) is already
bundled in `lib/`.

---

## How to run

### Windows
Double-click **`run.bat`**, or from a terminal in this folder:

```bat
run.bat
```

It compiles the code, starts the server on **http://localhost:8080**, and opens your browser.

On first run, watch the terminal — it prints the one-time **admin** password you need to
sign in with.

### macOS / Linux / Git Bash
```bash
./run.sh
```

### Choosing a different port
```bat
run.bat 9090
```
The port is taken from the first numeric argument, or the `PORT` environment variable if no
argument is given, otherwise **8080** — so it also drops straight into any launcher that
assigns a port through `PORT`.

### Headless self-test (no browser)
Seeds data, rings up a sample bill, writes both invoice PDFs and a backup, prints the
totals — handy on a server or for CI:
```bat
run-demo.bat        REM Windows
./run.sh --demo     # macOS / Linux
```

To stop the server, press **Ctrl+C** in its terminal window.

---

## Using the app

1. **Sign in** with the admin account (see the console on first run), then set your own
   password when asked.
2. **Dashboard** — see your store's numbers at a glance; admins can switch branches or view
   all of them combined at the top.
3. **New Bill** — scan a barcode or search/click products to build the cart, optionally
   enter the customer, discount and payment mode, then **Checkout & Print Invoice**. Both
   the A4 invoice and the thermal receipt are available from the confirmation screen.
4. **Products** — manage your real catalogue and stock (Add / Edit / Delete). Hidden for
   Cashier accounts.
5. **Invoices** — find and reprint any past bill, in either PDF format.
6. **Admin** (Admin accounts only) — manage branches, users, review the audit log, and
   download a backup.

---

## Customising your store

Store name, address, phone, email, GSTIN and currency (shown on the UI and every invoice)
live in **`data/store.properties`** (created on first run). Edit it and restart the server:

```properties
name=FreshMart Grocery Store
addressLine1=No. 12, Market Road, T. Nagar
addressLine2=Chennai - 600017, Tamil Nadu
phone=+91 98765 43210
email=billing@freshmart.example
gstin=33ABCDE1234F1Z5
currency=Rs.
```

This is also what the very first branch is seeded from on a brand new install.

---

## HTTP API (used by the web UI)

All `/api/...` routes except `POST /api/auth/login` and `GET /api/store` require a valid
session cookie (set by logging in). Most routes accept an optional `?branchId=` query
parameter for Admin accounts (`all` where supported); it is ignored for Manager/Cashier
accounts, who are always scoped to their own branch.

| Method | Path                          | Purpose                                          |
|--------|-------------------------------|---------------------------------------------------|
| GET    | `/api/store`                  | Store details (public)                            |
| POST   | `/api/auth/login`              | Sign in, sets the session cookie                  |
| POST   | `/api/auth/logout`             | Sign out                                           |
| GET    | `/api/auth/me`                 | Current session info                              |
| POST   | `/api/auth/change-password`    | Change (or first-time set) your password           |
| GET    | `/api/branches`                | List branches                                      |
| POST   | `/api/branches`                | Add a branch (Admin), optionally cloning a catalogue |
| PUT    | `/api/branches/{id}`           | Update a branch (Admin)                            |
| GET    | `/api/users`                   | List users (Admin)                                 |
| POST   | `/api/users`                   | Add a user (Admin)                                 |
| PUT    | `/api/users/{username}`        | Update a user / reset password (Admin)             |
| GET    | `/api/audit-log`               | Recent audit trail (Admin)                         |
| GET    | `/api/admin/backup`            | Download a zip of `data/` (Admin)                  |
| GET    | `/api/dashboard?from=&to=`     | Dashboard stats & analytics (sales scoped to the optional `yyyy-MM-dd` date window) |
| GET    | `/api/reports/z?date=&branchId=` | Day-end Z-report for the given date (totals, GST split, payment breakdown, top items) |
| GET    | `/api/items?q=&barcode=`       | List / search products, or look up one by barcode/SKU |
| POST   | `/api/items`                   | Add a product                                      |
| PUT    | `/api/items/{id}`              | Update a product                                   |
| DELETE | `/api/items/{id}`              | Delete a product                                   |
| POST   | `/api/checkout`                | Create a sale → returns the invoice                |
| GET    | `/api/invoices?from=&to=`      | List past invoices (optionally within a `yyyy-MM-dd` date window) |
| GET    | `/api/invoices/{no}/refundable` | Per-line refundable quantities for a given invoice (sold − already-refunded)  |
| GET    | `/api/refunds?from=&to=`       | List past refunds (optionally within a date window)                |
| GET    | `/api/refunds/{no}`            | One refund's detail                                                |
| POST   | `/api/refunds`                 | Create a refund against an invoice (restocks items atomically)      |
| GET    | `/api/invoices/{no}`           | One invoice's detail                               |
| GET    | `/api/invoices/{no}/pdf`       | Download / view the A4 invoice PDF                  |
| GET    | `/api/invoices/{no}/pdf?format=thermal` | Download / view the 80mm thermal receipt PDF |

---

## Where data is stored

| Path                       | Contents                                          |
|-----------------------------|----------------------------------------------------|
| `data/store.properties`    | Store details                                      |
| `data/branches.csv`        | Branches                                           |
| `data/users.csv`           | User accounts (password hashes, never plaintext)   |
| `data/items.csv`           | Product catalogue and stock levels, per branch     |
| `data/invoices.csv`        | One row per completed invoice (header/totals)      |
| `data/invoice_lines.csv`   | One row per billed line item                       |
| `data/refunds.csv`         | One row per refund (header/totals)                 |
| `data/refund_lines.csv`    | One row per refunded line item                     |
| `data/audit_log.csv`       | Append-only trail of who did what                  |
| `data/backups/yyyy-MM-dd/` | Automatic daily copy of the files above            |
| `invoices/INV-####.pdf`    | The generated A4 invoice for each sale             |
| `invoices/INV-####-thermal.pdf` | The generated thermal receipt for each sale   |

**Reset to a clean slate:** delete the `data/` and `invoices/` folders — a fresh admin
account, a single branch and the sample catalogue are re-seeded on the next run (and a new
one-time admin password is printed to the console).

**Upgrading from an older, single-branch install:** just run it — `items.csv` and
`invoices.csv` in the old format are detected and migrated automatically into the new
multi-branch schema on first load, with all existing data assigned to one branch seeded
from your existing `store.properties`.

---

## Project structure

```
src/grocery/
  Main.java                  Entry point (web server + --demo self-test, bootstrap)
  AppContext.java            Wires the services together
  PdfSelfCheck.java          Structural validator used by the self-test
  config/StoreConfig.java    Loads/saves store.properties
  auth/                      PasswordHasher, Session, SessionManager, AuthFilter
  model/                     Item, CartLine, Invoice, InvoiceLine, User, Role, Branch, AuditEntry
  service/
    InventoryService.java    Catalogue + stock, per branch (CSV persistence, seed data, atomic reserveStock)
    BillingService.java      Stateless checkout + validation
    InvoiceStore.java        Saves/loads invoices, atomic invoice numbering
    RefundService.java       Returns: atomic line-quantity guard + stock restore, RFD-#### numbering
    UserService.java         User accounts + authentication
    BranchService.java       Branches + catalogue cloning
    AuditLogService.java     Append-only audit trail
    BackupService.java       Zip download + daily automatic backup
  pdf/
    PdfDocument.java         Minimal, dependency-free PDF writer (any page size)
    InvoicePdfGenerator.java Lays out the A4 tax invoice
    ThermalReceiptPdfGenerator.java  Lays out the 80mm thermal receipt
  web/
    WebServer.java           Built-in HttpServer setup + auth filter wiring
    ApiHandler.java          All /api routes, role & branch enforcement, dashboard analytics
    StaticHandler.java       Serves the web/ front-end
    Json.java, Http.java     Gson + request/response/cookie helpers
    Dtos.java, Mappers.java  JSON shapes + model→DTO mapping
    ApiException.java        HTTP-status-carrying error type

web/                         The front-end (served at http://localhost:8080)
  index.html, css/style.css, js/app.js, favicon.svg

lib/gson-2.11.0.jar          The only third-party dependency (bundled)
```

---

## Notes & assumptions

- Currency shows as `Rs.` and GST is split into CGST + SGST (intra-state), matching a
  typical Indian grocery store. Change the currency in `store.properties`.
- Invoice PDFs use the standard Helvetica font and ASCII text so they render identically
  in every viewer (that's why the rupee symbol is written `Rs.` rather than `₹`).
- Sessions are plain HTTP cookies (not HTTPS-only), so they work out of the box on
  `localhost` or a trusted local network. If you expose this beyond a LAN you trust, put a
  TLS-terminating reverse proxy in front of it — the JDK's built-in `HttpServer` used here
  doesn't do HTTPS on its own.
- A sample invoice (`invoices/INV-1001.pdf`) is included so you can see the output
  immediately.
