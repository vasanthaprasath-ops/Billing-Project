package grocery.web;

import java.io.File;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import grocery.AppContext;
import grocery.auth.PasswordHasher;
import grocery.auth.Session;
import grocery.model.AuditEntry;
import grocery.model.Branch;
import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.model.Item;
import grocery.model.Refund;
import grocery.model.Role;
import grocery.model.User;
import grocery.service.BillingService;
import grocery.service.RefundService;
import grocery.util.CorrelationId;
import grocery.util.Log;
import grocery.util.Money;
import grocery.util.Text;
import grocery.util.Time;

/** Routes and handles all {@code /api/...} requests. */
public class ApiHandler implements HttpHandler {

    private final AppContext ctx;
    private final File invoicesDir;

    public ApiHandler(AppContext ctx, File invoicesDir) {
        this.ctx = ctx;
        this.invoicesDir = invoicesDir;
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        try {
            route(ex);
        } catch (ApiException e) {
            Http.sendError(ex, e.status, e.getMessage());
        } catch (IllegalStateException | IllegalArgumentException e) {
            Http.sendError(ex, 400, e.getMessage());
        } catch (Exception e) {
            // Never surface a raw JDBC/IO exception to the client - it can carry SQL
            // fragments, schema hints or filesystem paths. Log the full stack with a
            // correlation id and hand only the id back so an operator can grep it out
            // of data/logs/app.log.
            String cid = CorrelationId.next();
            Log.error("Unhandled server error [" + cid + "] " + ex.getRequestMethod() + " "
                    + ex.getRequestURI().getPath(), e);
            Http.sendError(ex, 500, "Server error (ref: " + cid + ")");
        }
    }

    private void route(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();
        String sub = path.substring("/api".length()); // e.g. "/items", "/invoices/INV-1001/pdf"
        if (sub.length() > 1 && sub.endsWith("/")) {
            sub = sub.substring(0, sub.length() - 1);
        }

        // ---- public: no session required (also exempted in AuthFilter) ----
        if (sub.equals("/store") && method.equals("GET")) {
            Http.sendJson(ex, 200, Mappers.store(ctx.store()));
            return;
        }
        if (sub.equals("/auth/login") && method.equals("POST")) {
            handleLogin(ex);
            return;
        }

        User user = (User) ex.getAttribute("user");
        if (user == null) {
            throw ApiException.notSignedIn();
        }

        // A user still flagged to set their first real password may only read their own session,
        // change the password, or log out - nothing else. Previously this was enforced only in the
        // UI (a forced modal), so a crafted client could skip it and use every other endpoint.
        if (user.isMustChangePassword()
                && !(method.equals("GET") && sub.equals("/auth/me"))
                && !(method.equals("POST") && sub.equals("/auth/change-password"))
                && !(method.equals("POST") && sub.equals("/auth/logout"))) {
            throw ApiException.forbidden("Please set a new password before continuing.");
        }

        if (sub.equals("/auth/me") && method.equals("GET")) {
            Http.sendJson(ex, 200, Mappers.session(user, ctx.branches()));
        } else if (sub.equals("/auth/logout") && method.equals("POST")) {
            handleLogout(ex, user);
        } else if (sub.equals("/auth/change-password") && method.equals("POST")) {
            handleChangePassword(ex, user);
        } else if (sub.equals("/branches") && method.equals("GET")) {
            handleListBranches(ex, user);
        } else if (sub.equals("/branches") && method.equals("POST")) {
            handleAddBranch(ex, user);
        } else if (sub.startsWith("/branches/") && method.equals("PUT")) {
            handleUpdateBranch(ex, user, sub.substring("/branches/".length()));
        } else if (sub.equals("/users") && method.equals("GET")) {
            handleListUsers(ex, user);
        } else if (sub.equals("/users") && method.equals("POST")) {
            handleAddUser(ex, user);
        } else if (sub.startsWith("/users/") && method.equals("PUT")) {
            handleUpdateUser(ex, user, sub.substring("/users/".length()));
        } else if (sub.equals("/audit-log") && method.equals("GET")) {
            handleAuditLog(ex, user);
        } else if (sub.equals("/admin/backup") && method.equals("GET")) {
            handleBackup(ex, user);
        } else if (sub.equals("/admin/restore") && method.equals("POST")) {
            handleRestore(ex, user);
        } else if (sub.equals("/dashboard") && method.equals("GET")) {
            Http.sendJson(ex, 200, buildDashboard(ex, user));
        } else if (sub.equals("/reports/z") && method.equals("GET")) {
            Http.sendJson(ex, 200, buildZReport(ex, user));
        } else if (sub.equals("/reports/z.pdf") && method.equals("GET")) {
            handleZReportPdf(ex, user);
        } else if (sub.equals("/items") && method.equals("GET")) {
            handleListItems(ex, user);
        } else if (sub.equals("/items") && method.equals("POST")) {
            handleAddItem(ex, user);
        } else if (sub.startsWith("/items/") && sub.endsWith("/adjust-stock") && method.equals("POST")) {
            String id = sub.substring("/items/".length(), sub.length() - "/adjust-stock".length());
            handleAdjustStock(ex, user, id);
        } else if (sub.startsWith("/items/") && method.equals("PUT")) {
            handleUpdateItem(ex, user, sub.substring("/items/".length()));
        } else if (sub.startsWith("/items/") && method.equals("DELETE")) {
            handleDeleteItem(ex, user, sub.substring("/items/".length()));
        } else if (sub.equals("/invoices.csv") && method.equals("GET")) {
            handleInvoicesCsv(ex, user);
        } else if (sub.equals("/invoices") && method.equals("GET")) {
            handleListInvoices(ex, user);
        } else if (sub.startsWith("/invoices/") && sub.endsWith("/pdf") && method.equals("GET")) {
            String no = sub.substring("/invoices/".length(), sub.length() - "/pdf".length());
            handleInvoicePdf(ex, user, no);
        } else if (sub.startsWith("/invoices/") && sub.endsWith("/refundable") && method.equals("GET")) {
            String no = sub.substring("/invoices/".length(), sub.length() - "/refundable".length());
            handleInvoiceRefundable(ex, user, no);
        } else if (sub.startsWith("/invoices/") && method.equals("GET")) {
            handleInvoiceDetail(ex, user, sub.substring("/invoices/".length()));
        } else if (sub.equals("/checkout") && method.equals("POST")) {
            handleCheckout(ex, user);
        } else if (sub.equals("/customers") && method.equals("GET")) {
            handleListCustomers(ex, user);
        } else if (sub.equals("/customers/history") && method.equals("GET")) {
            handleCustomerHistory(ex, user);
        } else if (sub.equals("/refunds") && method.equals("GET")) {
            handleListRefunds(ex, user);
        } else if (sub.equals("/refunds") && method.equals("POST")) {
            handleCreateRefund(ex, user);
        } else if (sub.startsWith("/refunds/") && method.equals("GET")) {
            handleRefundDetail(ex, user, sub.substring("/refunds/".length()));
        } else {
            Http.sendError(ex, 404, "No such endpoint: " + method + " " + path);
        }
    }

    // ---------------- auth ----------------

    private void handleLogin(HttpExchange ex) throws IOException {
        Dtos.LoginRequestDto req = Json.fromJson(Http.readBody(ex), Dtos.LoginRequestDto.class);
        if (req == null || req.username == null || req.password == null) {
            throw new IllegalArgumentException("Username and password are required.");
        }
        String ip = Http.remoteIp(ex);
        // IP throttle fires first: one attacker spraying many usernames still gets stopped
        // even though no single username has hit its own 5-attempt cap.
        java.time.Duration ipWait = ctx.loginRateLimiter().ipLockoutRemaining(ip);
        if (!ipWait.isZero()) {
            ctx.auditLog().logSystem("LOGIN_IP_LOCKED", "ip=" + ip
                    + " retry in " + Math.max(1, ipWait.toMinutes()) + "m");
            throw new ApiException(429, "Too many failed attempts. Try again in about "
                    + Math.max(1, ipWait.toMinutes()) + " minute(s).");
        }
        java.time.Duration wait = ctx.loginRateLimiter().lockoutRemaining(req.username);
        if (!wait.isZero()) {
            ctx.auditLog().logSystem("LOGIN_LOCKED", "username=" + req.username
                    + " retry in " + wait.toMinutes() + "m");
            throw new ApiException(429, "Too many failed attempts. Try again in about "
                    + Math.max(1, wait.toMinutes()) + " minute(s).");
        }
        User user = ctx.users().authenticate(req.username, req.password);
        if (user == null) {
            ctx.loginRateLimiter().recordFailure(req.username, ip);
            ctx.auditLog().logSystem("LOGIN_FAILED", "username=" + req.username + " ip=" + ip);
            throw new ApiException(401, "Invalid username or password.");
        }
        ctx.loginRateLimiter().recordSuccess(user.getUsername());
        Session session = ctx.sessions().create(user.getUsername());
        Http.setCookie(ex, "sid", session.token, 12 * 3600);
        ctx.auditLog().log(user, "LOGIN", "");
        Http.sendJson(ex, 200, Mappers.session(user, ctx.branches()));
    }

    private void handleLogout(HttpExchange ex, User user) throws IOException {
        ctx.sessions().invalidate(Http.readCookie(ex, "sid"));
        Http.setCookie(ex, "sid", "", 0);
        ctx.auditLog().log(user, "LOGOUT", "");
        Http.sendJson(ex, 200, ok());
    }

    private void handleChangePassword(HttpExchange ex, User user) throws IOException {
        Dtos.ChangePasswordDto req = Json.fromJson(Http.readBody(ex), Dtos.ChangePasswordDto.class);
        if (req == null || req.newPassword == null || req.newPassword.length() < 6) {
            throw new IllegalArgumentException("New password must be at least 6 characters.");
        }
        // A user who must still set their first real password doesn't need to prove a "current" one.
        if (!user.isMustChangePassword()
                && (req.currentPassword == null || !PasswordHasher.verify(req.currentPassword, user.getPasswordHash()))) {
            throw new IllegalArgumentException("Current password is incorrect.");
        }
        user.setPasswordHash(PasswordHasher.hash(req.newPassword));
        user.setMustChangePassword(false);
        ctx.users().update(user);
        ctx.sessions().invalidateAllFor(user.getUsername());
        Session session = ctx.sessions().create(user.getUsername());
        Http.setCookie(ex, "sid", session.token, 12 * 3600);
        ctx.auditLog().log(user, "PASSWORD_CHANGE", "");
        Http.sendJson(ex, 200, Mappers.session(user, ctx.branches()));
    }

    // ---------------- branches ----------------

    private void handleListBranches(HttpExchange ex, User user) throws IOException {
        // Branch address/phone/GSTIN is head-office information - only ADMIN gets the full list.
        // Manager/Cashier already know their own branch from /api/auth/me.
        requireRole(user, Role.ADMIN);
        List<Dtos.BranchDto> out = new ArrayList<>();
        for (Branch b : ctx.branches().getAll()) {
            out.add(Mappers.branch(b));
        }
        Http.sendJson(ex, 200, out);
    }

    private void handleAddBranch(HttpExchange ex, User user) throws IOException {
        requireRole(user, Role.ADMIN);
        Dtos.BranchDto dto = Json.fromJson(Http.readBody(ex), Dtos.BranchDto.class);
        if (dto == null || dto.name == null || dto.name.trim().isEmpty()) {
            throw new IllegalArgumentException("Branch name is required.");
        }
        Branch branch = new Branch(null, Text.oneLine(dto.name), nullToEmpty(dto.addressLine1),
                nullToEmpty(dto.addressLine2), nullToEmpty(dto.phone), nullToEmpty(dto.gstin),
                nullToEmpty(dto.stateCode).toUpperCase(), true);
        ctx.branches().add(branch);
        if (dto.cloneFromBranchId != null && !dto.cloneFromBranchId.isEmpty()) {
            ctx.branches().require(dto.cloneFromBranchId);
            ctx.inventory().cloneCatalogue(dto.cloneFromBranchId, branch.getId());
        }
        ctx.auditLog().log(user, "BRANCH_CREATE", branch.getId() + " " + branch.getName());
        Http.sendJson(ex, 201, Mappers.branch(branch));
    }

    private void handleUpdateBranch(HttpExchange ex, User user, String id) throws IOException {
        requireRole(user, Role.ADMIN);
        Dtos.BranchDto dto = Json.fromJson(Http.readBody(ex), Dtos.BranchDto.class);
        if (dto == null || dto.name == null || dto.name.trim().isEmpty()) {
            throw new IllegalArgumentException("Branch name is required.");
        }
        Branch branch = new Branch(id, Text.oneLine(dto.name), nullToEmpty(dto.addressLine1),
                nullToEmpty(dto.addressLine2), nullToEmpty(dto.phone), nullToEmpty(dto.gstin),
                nullToEmpty(dto.stateCode).toUpperCase(), dto.active);
        ctx.branches().update(branch);
        ctx.auditLog().log(user, "BRANCH_UPDATE", branch.getId() + " " + branch.getName());
        Http.sendJson(ex, 200, Mappers.branch(branch));
    }

    // ---------------- users ----------------

    private void handleListUsers(HttpExchange ex, User user) throws IOException {
        requireRole(user, Role.ADMIN);
        List<Dtos.UserDto> out = new ArrayList<>();
        for (User u : ctx.users().getAll()) {
            out.add(Mappers.user(u, ctx.branches()));
        }
        Http.sendJson(ex, 200, out);
    }

    private void handleAddUser(HttpExchange ex, User actor) throws IOException {
        requireRole(actor, Role.ADMIN);
        Dtos.UserDto dto = Json.fromJson(Http.readBody(ex), Dtos.UserDto.class);
        if (dto == null || dto.username == null || dto.username.trim().isEmpty()) {
            throw new IllegalArgumentException("Username is required.");
        }
        if (dto.password == null || dto.password.length() < 6) {
            throw new IllegalArgumentException("Password must be at least 6 characters.");
        }
        Role role = Role.parse(dto.role);
        String branchId = branchForRole(role, dto.branchId);
        User newUser = new User(Text.oneLine(dto.username), PasswordHasher.hash(dto.password),
                nullToEmpty(dto.fullName), role, branchId, true, true);
        ctx.users().add(newUser);
        ctx.auditLog().log(actor, "USER_CREATE", newUser.getUsername() + " role=" + role);
        Http.sendJson(ex, 201, Mappers.user(newUser, ctx.branches()));
    }

    private void handleUpdateUser(HttpExchange ex, User actor, String username) throws IOException {
        requireRole(actor, Role.ADMIN);
        User existing = ctx.users().findByUsername(username);
        if (existing == null) {
            throw ApiException.notFound("No user named '" + username + "'.");
        }
        Dtos.UserDto dto = Json.fromJson(Http.readBody(ex), Dtos.UserDto.class);
        if (dto == null) {
            throw new IllegalArgumentException("Missing user data.");
        }
        Role role = Role.parse(dto.role);
        String branchId = branchForRole(role, dto.branchId);
        if (existing.getUsername().equalsIgnoreCase(actor.getUsername())) {
            if (role != Role.ADMIN) {
                throw new IllegalArgumentException("You cannot remove your own admin role.");
            }
            if (!dto.active) {
                throw new IllegalArgumentException("You cannot deactivate your own account.");
            }
        }
        existing.setFullName(nullToEmpty(dto.fullName));
        existing.setRole(role);
        existing.setBranchId(branchId);
        existing.setActive(dto.active);
        if (dto.password != null && !dto.password.isEmpty()) {
            if (dto.password.length() < 6) {
                throw new IllegalArgumentException("Password must be at least 6 characters.");
            }
            existing.setPasswordHash(PasswordHasher.hash(dto.password));
            existing.setMustChangePassword(true);
            ctx.sessions().invalidateAllFor(existing.getUsername());
        }
        ctx.users().update(existing);
        ctx.auditLog().log(actor, "USER_UPDATE", existing.getUsername());
        Http.sendJson(ex, 200, Mappers.user(existing, ctx.branches()));
    }

    private String branchForRole(Role role, String requestedBranchId) {
        if (role == Role.ADMIN) {
            return null;
        }
        if (requestedBranchId == null || requestedBranchId.isEmpty()) {
            throw new IllegalArgumentException("Manager and Cashier accounts must be assigned a branch.");
        }
        ctx.branches().require(requestedBranchId);
        return requestedBranchId;
    }

    // ---------------- audit log & backup ----------------

    private void handleAuditLog(HttpExchange ex, User user) throws IOException {
        requireRole(user, Role.ADMIN);
        String branchFilter = Http.queryParams(ex).get("branchId");
        if (branchFilter != null && (branchFilter.isEmpty() || branchFilter.equalsIgnoreCase("all"))) {
            branchFilter = null;
        }
        List<Dtos.AuditEntryDto> out = new ArrayList<>();
        for (AuditEntry e : ctx.auditLog().recent(500, branchFilter)) {
            out.add(Mappers.auditEntry(e));
        }
        Http.sendJson(ex, 200, out);
    }

    private void handleBackup(HttpExchange ex, User user) throws IOException {
        requireRole(user, Role.ADMIN);
        byte[] zip = ctx.backup().zipData();
        ctx.auditLog().log(user, "BACKUP_DOWNLOAD", zip.length + " bytes");
        String filename = "freshmart-backup-" + Time.today() + ".zip";
        ex.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"" + filename + "\"");
        Http.sendBytes(ex, 200, "application/zip", zip);
    }

    private void handleRestore(HttpExchange ex, User user) throws IOException {
        requireRole(user, Role.ADMIN);
        // 256 MB ceiling: far above any realistic single-store DB, low enough to refuse abuse.
        byte[] zip = Http.readBodyBytes(ex, 256 * 1024 * 1024);
        if (zip.length == 0) {
            throw new IllegalArgumentException("No backup file was received.");
        }
        String summary = ctx.backup().stageRestore(zip);
        ctx.auditLog().log(user, "RESTORE_STAGED", summary);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("staged", true);
        body.put("message", "Backup staged (" + summary + "). Restart the app to complete the restore.");
        Http.sendJson(ex, 200, body);
    }

    // ---------------- items ----------------

    private void handleListItems(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchId(ex, user);
        Map<String, String> q = Http.queryParams(ex);
        List<Dtos.ItemDto> out = new ArrayList<>();
        String barcode = q.get("barcode");
        if (barcode != null && !barcode.isEmpty()) {
            // A scan matches the barcode field; typing a known item id (SKU) works too.
            Item hit = ctx.inventory().findByBarcode(branchId, barcode);
            if (hit == null) {
                hit = ctx.inventory().findInBranch(branchId, barcode);
            }
            if (hit != null) {
                out.add(Mappers.item(hit));
            }
        } else {
            for (Item it : ctx.inventory().search(branchId, q.get("q"))) {
                out.add(Mappers.item(it));
            }
        }
        Http.sendJson(ex, 200, out);
    }

    private void handleAddItem(HttpExchange ex, User user) throws IOException {
        requireRole(user, Role.ADMIN, Role.MANAGER);
        Dtos.ItemDto dto = Json.fromJson(Http.readBody(ex), Dtos.ItemDto.class);
        String branchId = resolveBranchIdForBody(user, dto == null ? null : dto.branchId);
        Item item = toItem(dto, dto != null ? dto.id : null, branchId);
        ctx.inventory().add(item);
        ctx.auditLog().log(user, "ITEM_CREATE", item.getId() + " " + item.getName());
        Http.sendJson(ex, 201, Mappers.item(item));
    }

    private void handleUpdateItem(HttpExchange ex, User user, String id) throws IOException {
        requireRole(user, Role.ADMIN, Role.MANAGER);
        Dtos.ItemDto dto = Json.fromJson(Http.readBody(ex), Dtos.ItemDto.class);
        String branchId = resolveBranchIdForBody(user, dto == null ? null : dto.branchId);
        Item previous = ctx.inventory().findInBranch(branchId, id);
        Item item = toItem(dto, id, branchId);
        // If the client omitted costPrice, preserve the existing value (same "form snapshot
        // must not clobber unrelated fields" defense we do for stock).
        if (dto != null && dto.costPrice == null && previous != null) {
            item.setCostPrice(previous.getCostPrice());
        }
        ctx.inventory().update(branchId, item);
        String change = (previous != null && previous.getPrice().compareTo(item.getPrice()) != 0)
                ? (" price " + Money.format(previous.getPrice()) + " -> " + Money.format(item.getPrice())) : "";
        ctx.auditLog().log(user, "ITEM_UPDATE", item.getId() + " " + item.getName() + change);
        Http.sendJson(ex, 200, Mappers.item(item));
    }

    /**
     * Add or remove stock as an explicit, audited action - the correct way to change a stock
     * number, instead of editing the product row. Accepts either {@code delta} (signed, e.g.
     * +50 for a delivery) or {@code newStock} (absolute; delta is computed from current). Reason
     * is optional but recommended; every adjust writes an audit entry so shrinkage/waste can
     * later be reconciled from the log.
     */
    private void handleAdjustStock(HttpExchange ex, User user, String id) throws IOException {
        requireRole(user, Role.ADMIN, Role.MANAGER);
        Dtos.StockAdjustDto dto = Json.fromJson(Http.readBody(ex), Dtos.StockAdjustDto.class);
        if (dto == null) {
            throw new IllegalArgumentException("Missing request body.");
        }
        String branchId = resolveBranchIdForBody(user, dto.branchId);
        Item before = ctx.inventory().findInBranch(branchId, id);
        if (before == null) {
            throw new IllegalArgumentException("No item with id '" + id + "' in this branch.");
        }
        double delta;
        if (dto.delta != null) {
            delta = dto.delta;
        } else if (dto.newStock != null) {
            delta = dto.newStock - before.getStock();
        } else {
            throw new IllegalArgumentException("Provide either 'delta' or 'newStock'.");
        }
        if (Double.isNaN(delta) || Double.isInfinite(delta)) {
            throw new IllegalArgumentException("Stock change must be a finite number.");
        }
        ctx.inventory().adjustStock(branchId, id, delta);
        Item after = ctx.inventory().findInBranch(branchId, id);
        String reason = dto.reason == null ? "" : dto.reason.trim();
        String sign = delta >= 0 ? "+" : "";
        String details = id + " " + before.getName() + " " + sign + delta
                + " (" + before.getStock() + " -> " + (after == null ? "?" : after.getStock()) + ")"
                + (reason.isEmpty() ? "" : " reason=" + reason);
        ctx.auditLog().log(user, "STOCK_ADJUST", details);
        Http.sendJson(ex, 200, Mappers.item(after));
    }

    private void handleDeleteItem(HttpExchange ex, User user, String id) throws IOException {
        requireRole(user, Role.ADMIN, Role.MANAGER);
        String branchId = resolveBranchId(ex, user);
        ctx.inventory().delete(branchId, id);
        ctx.auditLog().log(user, "ITEM_DELETE", id);
        Http.sendJson(ex, 200, ok());
    }

    private Item toItem(Dtos.ItemDto dto, String id, String branchId) {
        if (dto == null) {
            throw new IllegalArgumentException("Missing item data.");
        }
        if (dto.name == null || dto.name.trim().isEmpty()) {
            throw new IllegalArgumentException("Item name is required.");
        }
        if (dto.price < 0 || dto.taxRatePercent < 0 || dto.stock < 0 || dto.reorderLevel < 0) {
            throw new IllegalArgumentException("Price, GST %, stock and reorder level cannot be negative.");
        }
        if (dto.costPrice != null && dto.costPrice < 0) {
            throw new IllegalArgumentException("Cost price cannot be negative.");
        }
        // Enforce the legal Indian GST slabs. Old data on disk that pre-dates this check is
        // untouched (schema is unchanged) but any new write must land in a valid slab.
        // Accept some floating-point slack (e.g. 5.0000001) since the value flows via double.
        double[] slabs = {0, 5, 12, 18, 28};
        boolean ok = false;
        for (double s : slabs) {
            if (Math.abs(dto.taxRatePercent - s) < 0.01) { dto.taxRatePercent = s; ok = true; break; }
        }
        if (!ok) {
            throw new IllegalArgumentException("GST % must be one of 0, 5, 12, 18 or 28 (India's legal slabs).");
        }
        String unit = dto.unit == null || dto.unit.trim().isEmpty() ? "pc" : Text.oneLine(dto.unit);
        String category = dto.category == null || dto.category.trim().isEmpty() ? "General" : Text.oneLine(dto.category);
        String barcode = Text.oneLine(dto.barcode);
        java.math.BigDecimal cost = dto.costPrice == null ? Money.ZERO : Money.of(dto.costPrice);
        return new Item(id == null ? null : Text.oneLine(id), branchId, Text.oneLine(dto.name), category, unit,
                Money.of(dto.price), cost, dto.taxRatePercent, dto.stock, barcode, dto.reorderLevel);
    }

    // ---------------- invoices ----------------

    /**
     * Period CSV export of invoices for the accountant / GST filing. Accepts the same
     * {@code ?from}, {@code ?to}, {@code ?branchId} query params as the JSON list endpoint. One row
     * per invoice, columns cover the totals + tax split (CGST/SGST/IGST) so an accountant can
     * hand it straight into a GSTR-1 workbook. Fields are RFC-4180 quoted; the response prompts
     * a download with a date-stamped filename.
     */
    private void handleInvoicesCsv(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchIdOrAll(ex, user);
        List<Invoice> list = branchId == null ? ctx.invoiceStore().getAll() : ctx.invoiceStore().getAllForBranch(branchId);
        list = filterByDate(ex, list);

        StringBuilder sb = new StringBuilder(4096);
        sb.append("Invoice No,Date,Branch,Cashier,Customer,Phone,Payment,Place of Supply,"
                + "Sub Total,Discount,CGST,SGST,IGST,Round Off,Grand Total\r\n");
        for (Invoice inv : list) {
            Dtos.InvoiceDto d = Mappers.invoice(inv, ctx.branches());
            sb.append(csvCell(inv.getInvoiceNo())).append(',')
              .append(csvCell(d.dateTime)).append(',')
              .append(csvCell(d.branchName)).append(',')
              .append(csvCell(inv.getCashierUsername())).append(',')
              .append(csvCell(inv.getCustomerName())).append(',')
              .append(csvCell(inv.getCustomerPhone())).append(',')
              .append(csvCell(inv.getPaymentMode())).append(',')
              .append(csvCell(inv.getPlaceOfSupplyStateCode())).append(',')
              .append(Money.format(inv.getSubTotal())).append(',')
              .append(Money.format(inv.getDiscount())).append(',')
              .append(Money.format(inv.getCgst())).append(',')
              .append(Money.format(inv.getSgst())).append(',')
              .append(Money.format(inv.getIgst())).append(',')
              .append(Money.format(inv.getRoundOff())).append(',')
              .append(Money.format(inv.getGrandTotal())).append("\r\n");
        }
        Map<String, String> q = Http.queryParams(ex);
        String stamp = q.getOrDefault("from", "all") + "_to_" + q.getOrDefault("to", "all");
        ex.getResponseHeaders().set("Content-Disposition",
                "attachment; filename=\"invoices-" + stamp + ".csv\"");
        Http.sendBytes(ex, 200, "text/csv; charset=utf-8",
                sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    /** RFC-4180 minimal quoting: wrap in quotes if it contains a comma, quote, or CR/LF. */
    private static String csvCell(String s) {
        if (s == null) return "";
        boolean needs = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0;
        if (!needs) return s;
        return "\"" + s.replace("\"", "\"\"") + "\"";
    }

    /**
     * Printable Z-report PDF - the day-end/reconciliation sheet the owner or accountant wants to
     * keep. Reuses the same buildZReport() the JSON endpoint returns; rendering leans on the
     * hand-rolled PdfDocument that already ships the invoice PDFs.
     */
    private void handleZReportPdf(HttpExchange ex, User user) throws IOException {
        Dtos.ZReportDto z = buildZReport(ex, user);
        String cur = ctx.store().getCurrency() + " ";
        grocery.pdf.PdfDocument d = new grocery.pdf.PdfDocument();
        d.newPage();
        float y = 60;
        d.text(50, y, 18, true, "Day-End Z-Report");
        y += 22;
        d.text(50, y, 11, false, z.branchName + "  ·  " + z.date);
        y += 22;
        // Left column of "totals" table, right column of "payment mix".
        d.text(50, y, 11, true, "Totals");
        d.text(320, y, 11, true, "Payment Mix");
        y += 16;
        float ty = y;
        String[][] rows = {
                {"Sub Total",     cur + Money.format(java.math.BigDecimal.valueOf(z.subTotal))},
                {"Discounts",     "- " + cur + Money.format(java.math.BigDecimal.valueOf(z.discount))},
                {"CGST",          cur + Money.format(java.math.BigDecimal.valueOf(z.cgst))},
                {"SGST",          cur + Money.format(java.math.BigDecimal.valueOf(z.sgst))},
                {"IGST",          cur + Money.format(java.math.BigDecimal.valueOf(z.igst))},
                {"Round Off",     cur + Money.format(java.math.BigDecimal.valueOf(z.roundOff))},
                {"Grand Total",   cur + Money.format(java.math.BigDecimal.valueOf(z.grandTotal))},
                {"Refunds (" + z.refundCount + ")", "- " + cur + Money.format(java.math.BigDecimal.valueOf(z.refundTotal))},
                {"Net Sales",     cur + Money.format(java.math.BigDecimal.valueOf(z.netSales))},
                {"Cash in Drawer",cur + Money.format(java.math.BigDecimal.valueOf(z.cashInDrawer))},
                {"Invoice Range", (z.firstInvoiceNo == null ? "-" : z.firstInvoiceNo) + " to "
                                 + (z.lastInvoiceNo == null ? "-" : z.lastInvoiceNo)}
        };
        for (String[] row : rows) {
            d.text(50, ty, 10.5f, false, row[0]);
            d.text(280 - d.textWidth(row[1], 10.5f), ty, 10.5f, false, row[1]);
            ty += 14;
        }
        // Payment mix column
        float py = y;
        if (z.byPayment != null) {
            for (Dtos.PaymentBreakdownDto p : z.byPayment) {
                d.text(320, py, 10.5f, false, p.mode + "  (" + p.count + ")");
                String amt = cur + Money.format(java.math.BigDecimal.valueOf(p.amount));
                d.text(540 - d.textWidth(amt, 10.5f), py, 10.5f, false, amt);
                py += 14;
            }
        }
        // Top items block below both columns
        float bottomY = Math.max(ty, py) + 20;
        d.text(50, bottomY, 11, true, "Top Items (by revenue)");
        bottomY += 16;
        if (z.topItems != null) {
            for (Dtos.TopItemDto t : z.topItems) {
                d.text(50, bottomY, 10.5f, false, t.name);
                String qty = grocery.util.Money.format(java.math.BigDecimal.valueOf(t.quantity))
                        + (t.unit == null ? "" : " " + t.unit);
                d.text(340, bottomY, 10.5f, false, qty);
                String amt = cur + Money.format(java.math.BigDecimal.valueOf(t.amount));
                d.text(540 - d.textWidth(amt, 10.5f), bottomY, 10.5f, false, amt);
                bottomY += 14;
            }
        }
        byte[] bytes = d.toBytes();
        String filename = "z-report-" + z.date + ".pdf";
        ex.getResponseHeaders().set("Content-Disposition", "inline; filename=\"" + filename + "\"");
        Http.sendBytes(ex, 200, "application/pdf", bytes);
    }


    private void handleListInvoices(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchIdOrAll(ex, user);
        List<Invoice> list = branchId == null ? ctx.invoiceStore().getAll() : ctx.invoiceStore().getAllForBranch(branchId);
        list = filterByDate(ex, list);

        // Pagination. Backwards-compatible default: if no limit is given, return the whole
        // filtered set as a bare array (what every existing caller expects). When ?limit= is
        // present we switch to the {items,total,offset,limit} envelope so the UI can page.
        // Big stores were slow to scroll a several-thousand-invoice history all at once even
        // though the query is in-memory - a limit keeps the JSON payload and DOM small.
        Map<String, String> q = Http.queryParams(ex);
        String rawLimit = q.get("limit");
        if (rawLimit == null || rawLimit.isEmpty()) {
            List<Dtos.InvoiceDto> out = new ArrayList<>(list.size());
            for (Invoice inv : list) {
                out.add(Mappers.invoice(inv, ctx.branches()));
            }
            Http.sendJson(ex, 200, out);
            return;
        }
        Dtos.PageDto<Dtos.InvoiceDto> page = paginate(list, q, this::invoiceToDto);
        Http.sendJson(ex, 200, page);
    }

    private Dtos.InvoiceDto invoiceToDto(Invoice inv) {
        return Mappers.invoice(inv, ctx.branches());
    }

    /**
     * Slice a filtered list per {@code ?limit=} and {@code ?offset=} into the paged envelope.
     * limit is clamped to [1, 1000]; offset is clamped to [0, total]. Kept generic so the
     * refunds list can reuse the same shape.
     */
    private <T, R> Dtos.PageDto<R> paginate(List<T> list, Map<String, String> q, java.util.function.Function<T, R> mapper) {
        int total = list.size();
        int limit = parseIntOr(q.get("limit"), 50);
        if (limit < 1) limit = 1;
        if (limit > 1000) limit = 1000;
        int offset = parseIntOr(q.get("offset"), 0);
        if (offset < 0) offset = 0;
        if (offset > total) offset = total;
        int end = Math.min(offset + limit, total);
        List<R> items = new ArrayList<>(end - offset);
        for (int i = offset; i < end; i++) {
            items.add(mapper.apply(list.get(i)));
        }
        Dtos.PageDto<R> p = new Dtos.PageDto<>();
        p.items = items;
        p.total = total;
        p.offset = offset;
        p.limit = limit;
        return p;
    }

    private static int parseIntOr(String s, int fallback) {
        if (s == null || s.isEmpty()) return fallback;
        try { return Integer.parseInt(s.trim()); } catch (NumberFormatException e) { return fallback; }
    }

    private void handleInvoiceDetail(HttpExchange ex, User user, String no) throws IOException {
        Invoice inv = requireInvoiceInScope(user, no);
        Http.sendJson(ex, 200, Mappers.invoice(inv, ctx.branches()));
    }

    private static final java.util.regex.Pattern SAFE_INVOICE_NO =
            java.util.regex.Pattern.compile("[A-Za-z][A-Za-z0-9_-]{0,63}");

    private void handleInvoicePdf(HttpExchange ex, User user, String no) throws IOException {
        Invoice inv = requireInvoiceInScope(user, no);
        // Defence in depth: even though the invoice number came from the DB, a legacy CSV
        // migration could have imported one containing "../" or path separators, and this
        // handler concatenates it straight into a filesystem path. Reject anything that
        // isn't a plain [A-Za-z][A-Za-z0-9_-]{0,63} token and then re-canonicalise the
        // final path is still inside invoicesDir - either check on its own would have
        // caught the escape, but they combine to leave no room for a surprise.
        String invoiceNo = inv.getInvoiceNo();
        if (!SAFE_INVOICE_NO.matcher(invoiceNo).matches()) {
            throw ApiException.notFound("Invoice not found: " + no);
        }
        boolean thermal = "thermal".equalsIgnoreCase(Http.queryParams(ex).get("format"));
        File pdf = new File(invoicesDir, invoiceNo + (thermal ? "-thermal.pdf" : ".pdf"));
        java.nio.file.Path dirPath = invoicesDir.getCanonicalFile().toPath();
        if (!pdf.getCanonicalFile().toPath().startsWith(dirPath)) {
            throw ApiException.notFound("Invoice not found: " + no);
        }
        if (!pdf.exists()) {
            pdf = thermal ? ctx.thermalPdfGenerator().generate(inv, invoicesDir)
                    : ctx.pdfGenerator().generate(inv, invoicesDir);
            if (!pdf.getCanonicalFile().toPath().startsWith(dirPath)) {
                throw ApiException.notFound("Invoice not found: " + no);
            }
        }
        ex.getResponseHeaders().set("Content-Disposition", "inline; filename=\"" + pdf.getName() + "\"");
        Http.sendBytes(ex, 200, "application/pdf", Files.readAllBytes(pdf.toPath()));
    }

    private Invoice requireInvoiceInScope(User user, String no) {
        Invoice inv = ctx.invoiceStore().findByNo(no);
        if (inv == null) {
            throw ApiException.notFound("Invoice not found: " + no);
        }
        if (!user.canAccessBranch(inv.getBranchId())) {
            throw ApiException.forbidden("That invoice belongs to another branch.");
        }
        return inv;
    }

    private void handleCheckout(HttpExchange ex, User user) throws IOException {
        Dtos.CheckoutRequestDto req = Json.fromJson(Http.readBody(ex), Dtos.CheckoutRequestDto.class);
        if (req == null) {
            throw new IllegalArgumentException("Missing checkout data.");
        }
        // Sanitize the money fields at the boundary: NaN, +/-Infinity or absurd magnitudes
        // slip through BigDecimal.valueOf and produce garbage invoices. Reject at the door.
        double discount = sanitizeMoney(req.discount, "discount");
        double paid = sanitizeMoney(req.amountPaid, "amount paid");
        String branchId = resolveBranchIdForBody(user, req.branchId);
        List<BillingService.LineRequest> lines = new ArrayList<>();
        if (req.lines != null) {
            for (Dtos.CheckoutLineDto l : req.lines) {
                double qty = l.quantity;
                if (!Double.isFinite(qty) || qty < 0 || qty > 1_000_000) {
                    throw new IllegalArgumentException("Line quantity is out of range.");
                }
                lines.add(new BillingService.LineRequest(l.itemId, qty));
            }
        }
        // GST place-of-supply: empty from the client -> intra-state (branch's own state).
        // Uppercased so "tn" and "TN" match consistently regardless of what the client sends.
        Branch branch = ctx.branches().findById(branchId);
        String branchState = branch == null ? "" : branch.getStateCode();
        String posState = req.placeOfSupplyStateCode == null ? "" : req.placeOfSupplyStateCode.trim().toUpperCase();
        Invoice invoice = ctx.billing().checkout(
                branchId, user.getUsername(), req.customerName, req.customerPhone, req.paymentMode,
                BigDecimal.valueOf(discount), BigDecimal.valueOf(paid),
                lines, ctx.inventory(), ctx.invoiceStore(),
                posState, branchState);
        ctx.pdfGenerator().generate(invoice, invoicesDir); // pre-generate the A4 PDF
        ctx.auditLog().log(user, "CHECKOUT", invoice.getInvoiceNo() + " " + Money.format(invoice.getGrandTotal()));
        Http.sendJson(ex, 201, Mappers.invoice(invoice, ctx.branches()));
    }

    private static double sanitizeMoney(double v, String fieldName) {
        if (!Double.isFinite(v)) {
            throw new IllegalArgumentException(fieldName + " must be a finite number.");
        }
        if (v < 0 || v > 100_000_000) { // ten crore is well above any realistic bill
            throw new IllegalArgumentException(fieldName + " is out of range.");
        }
        return v;
    }

    // ---------------- customers (derived from invoices) ----------------

    /**
     * The store's customer list, derived from the invoices already on file. No schema change:
     * we aggregate name+phone across every invoice in scope, so what we call a "customer" is
     * really "all sales matched by phone number (or name, when phone is blank)". Ranked by
     * most-recent purchase; a {@code ?q=} filter matches substrings in either field.
     */
    private void handleListCustomers(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchIdOrAll(ex, user);
        List<Invoice> list = branchId == null ? ctx.invoiceStore().getAll() : ctx.invoiceStore().getAllForBranch(branchId);
        String q = Http.queryParams(ex).getOrDefault("q", "").trim().toLowerCase();

        // Aggregate by phone-or-name key. LinkedHashMap keeps first-seen insertion order until we sort.
        Map<String, Dtos.CustomerSummaryDto> agg = new LinkedHashMap<>();
        for (Invoice inv : list) {
            String phone = inv.getCustomerPhone() == null ? "" : inv.getCustomerPhone().trim();
            String name = inv.getCustomerName() == null ? "" : inv.getCustomerName().trim();
            if (phone.isEmpty() && (name.isEmpty() || name.equalsIgnoreCase("Walk-in Customer"))) {
                continue; // Anonymous walk-ins aren't customers to remember.
            }
            String key = phone.isEmpty() ? ("name:" + name.toLowerCase()) : ("phone:" + phone);
            Dtos.CustomerSummaryDto c = agg.get(key);
            if (c == null) {
                c = new Dtos.CustomerSummaryDto();
                c.phone = phone;
                c.name = name;
                agg.put(key, c);
            }
            c.invoiceCount++;
            c.totalSpent += inv.getGrandTotal().doubleValue();
            String stamped = Mappers.invoice(inv, ctx.branches()).dateTime;
            if (c.lastVisit == null || stamped.compareTo(c.lastVisit) > 0) {
                c.lastVisit = stamped;
                c.lastInvoiceNo = inv.getInvoiceNo();
                if (!name.isEmpty()) c.name = name; // prefer the latest name for that phone
            }
        }

        List<Dtos.CustomerSummaryDto> out = new ArrayList<>(agg.values());
        if (!q.isEmpty()) {
            out.removeIf(c -> !(c.phone.toLowerCase().contains(q) || c.name.toLowerCase().contains(q)));
        }
        // Newest first - the just-served customer needs to be findable immediately.
        out.sort((a, b) -> b.lastVisit == null ? -1 : a.lastVisit == null ? 1 : b.lastVisit.compareTo(a.lastVisit));
        // Cap at 200: the checkout type-ahead only wants the top few, and the Customers view
        // paginates client-side. A shop's whole customer list won't blow this up for a while.
        if (out.size() > 200) {
            out = out.subList(0, 200);
        }
        for (Dtos.CustomerSummaryDto c : out) {
            c.totalSpent = round2(c.totalSpent);
        }
        Http.sendJson(ex, 200, out);
    }

    /** Every invoice matching a phone (or, if phone is blank, an exact name). Branch-scoped. */
    private void handleCustomerHistory(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchIdOrAll(ex, user);
        Map<String, String> q = Http.queryParams(ex);
        String phone = q.getOrDefault("phone", "").trim();
        String name = q.getOrDefault("name", "").trim();
        if (phone.isEmpty() && name.isEmpty()) {
            throw new IllegalArgumentException("Provide 'phone' or 'name'.");
        }
        List<Invoice> list = branchId == null ? ctx.invoiceStore().getAll() : ctx.invoiceStore().getAllForBranch(branchId);
        List<Dtos.InvoiceDto> out = new ArrayList<>();
        for (Invoice inv : list) {
            boolean phoneMatch = !phone.isEmpty()
                    && phone.equalsIgnoreCase(inv.getCustomerPhone() == null ? "" : inv.getCustomerPhone().trim());
            boolean nameMatch = phone.isEmpty() && !name.isEmpty()
                    && name.equalsIgnoreCase(inv.getCustomerName() == null ? "" : inv.getCustomerName().trim());
            if (phoneMatch || nameMatch) {
                out.add(Mappers.invoice(inv, ctx.branches()));
            }
        }
        Http.sendJson(ex, 200, out);
    }

    // ---------------- refunds ----------------

    private void handleInvoiceRefundable(HttpExchange ex, User user, String no) throws IOException {
        Invoice inv = requireInvoiceInScope(user, no);
        Map<String, Double> already = ctx.refunds().refundedQuantitiesFor(inv.getInvoiceNo());
        Dtos.InvoiceRefundableDto d = new Dtos.InvoiceRefundableDto();
        d.invoiceNo = inv.getInvoiceNo();
        d.branchId = inv.getBranchId();
        d.dateTime = Mappers.invoice(inv, ctx.branches()).dateTime;
        d.customerName = inv.getCustomerName();
        d.paymentMode = inv.getPaymentMode();
        d.grandTotal = inv.getGrandTotal().doubleValue();
        d.lines = new ArrayList<>();
        // Collapse duplicate item ids on the original bill so the modal shows one row per item.
        Map<String, InvoiceLine> merged = new LinkedHashMap<>();
        for (InvoiceLine line : inv.getLines()) {
            merged.merge(line.getItemId(), line, (a, b) -> new InvoiceLine(a.getItemId(), a.getName(),
                    a.getUnit(), a.getPrice(), a.getTaxRatePercent(), a.getQuantity() + b.getQuantity(),
                    a.getAmount().add(b.getAmount()), a.getTax().add(b.getTax())));
        }
        for (InvoiceLine line : merged.values()) {
            d.lines.add(new Dtos.RefundableLineDto(line.getItemId(), line.getName(), line.getUnit(),
                    line.getPrice().doubleValue(), line.getTaxRatePercent(),
                    line.getQuantity(), already.getOrDefault(line.getItemId(), 0.0)));
        }
        d.anyRefundable = d.lines.stream().anyMatch(l -> l.remaining > 0);
        Http.sendJson(ex, 200, d);
    }

    private void handleListRefunds(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchIdOrAll(ex, user);
        List<Refund> list = branchId == null ? ctx.refunds().getAll() : ctx.refunds().getAllForBranch(branchId);
        list = filterRefundsByDate(ex, list);
        Map<String, String> q = Http.queryParams(ex);
        // Same backwards-compat paging shape as /invoices: no ?limit -> bare array (unchanged),
        // with ?limit= -> {items,total,offset,limit} envelope.
        if (q.get("limit") == null || q.get("limit").isEmpty()) {
            List<Dtos.RefundDto> out = new ArrayList<>(list.size());
            for (Refund r : list) {
                out.add(Mappers.refund(r, ctx.branches()));
            }
            Http.sendJson(ex, 200, out);
            return;
        }
        Http.sendJson(ex, 200, paginate(list, q, r -> Mappers.refund(r, ctx.branches())));
    }

    private void handleRefundDetail(HttpExchange ex, User user, String no) throws IOException {
        Refund r = ctx.refunds().findByNo(no);
        if (r == null) {
            throw ApiException.notFound("Refund not found: " + no);
        }
        if (!user.canAccessBranch(r.getBranchId())) {
            throw ApiException.forbidden("That refund belongs to another branch.");
        }
        Http.sendJson(ex, 200, Mappers.refund(r, ctx.branches()));
    }

    private void handleCreateRefund(HttpExchange ex, User user) throws IOException {
        // Refunds move money out of the till, so they need a manager's authority - a plain
        // cashier can ring up sales but not sign off returns. This is the standard shrinkage
        // control in retail; the frontend hides the Return button for cashiers to match.
        requireRole(user, Role.ADMIN, Role.MANAGER);
        Dtos.RefundRequestDto req = Json.fromJson(Http.readBody(ex), Dtos.RefundRequestDto.class);
        if (req == null || req.originalInvoiceNo == null || req.originalInvoiceNo.isEmpty()) {
            throw new IllegalArgumentException("Original invoice number is required.");
        }
        Invoice original = requireInvoiceInScope(user, req.originalInvoiceNo);
        List<RefundService.LineRequest> lines = new ArrayList<>();
        if (req.lines != null) {
            for (Dtos.RefundLineRequestDto l : req.lines) {
                lines.add(new RefundService.LineRequest(l.itemId, l.quantity));
            }
        }
        Refund refund = ctx.refunds().createRefund(original, user.getUsername(), lines,
                req.reason, ctx.inventory());
        ctx.auditLog().log(user, "REFUND", refund.getRefundNo() + " for " + refund.getOriginalInvoiceNo()
                + " " + Money.format(refund.getRefundAmount()));
        Http.sendJson(ex, 201, Mappers.refund(refund, ctx.branches()));
    }

    private List<Refund> filterRefundsByDate(HttpExchange ex, List<Refund> refunds) {
        Map<String, String> q = Http.queryParams(ex);
        LocalDate from = parseDate(q.get("from"));
        LocalDate to = parseDate(q.get("to"));
        if (from == null && to == null) {
            return refunds;
        }
        List<Refund> out = new ArrayList<>();
        for (Refund r : refunds) {
            LocalDate day = r.getDateTime().toLocalDate();
            if (from != null && day.isBefore(from)) continue;
            if (to != null && day.isAfter(to)) continue;
            out.add(r);
        }
        return out;
    }

    // ---------------- dashboard ----------------

    private Dtos.DashboardDto buildDashboard(HttpExchange ex, User user) throws IOException {
        String branchId = resolveBranchIdOrAll(ex, user);
        // Sales figures are scoped to the requested reporting period; the catalogue and
        // low-stock alerts always reflect current inventory state, not a past window.
        List<Invoice> invoices = branchId == null ? ctx.invoiceStore().getAll() : ctx.invoiceStore().getAllForBranch(branchId);
        invoices = filterByDate(ex, invoices);
        List<Item> items = branchId == null ? allItemsAcrossBranches() : ctx.inventory().getAll(branchId);

        Dtos.DashboardDto d = new Dtos.DashboardDto();
        d.allBranches = branchId == null;
        d.branchId = branchId;
        d.branchName = branchId == null ? "All Branches" : ctx.branches().require(branchId).getName();
        Map<String, String> params = Http.queryParams(ex);
        d.periodFrom = normaliseDate(params.get("from"));
        d.periodTo = normaliseDate(params.get("to"));
        d.invoiceCount = invoices.size();
        d.itemCount = items.size();

        double total = 0;
        for (Invoice inv : invoices) {
            total += inv.getGrandTotal().doubleValue();
        }
        d.totalSales = round2(total);
        d.averageSale = invoices.isEmpty() ? 0 : round2(total / invoices.size());

        // Refunds in the same period + scope. Net sales is what the shop actually keeps.
        List<Refund> refundsInScope = branchId == null ? ctx.refunds().getAll() : ctx.refunds().getAllForBranch(branchId);
        refundsInScope = filterRefundsByDate(ex, refundsInScope);
        double refundTotal = 0;
        for (Refund r : refundsInScope) {
            refundTotal += r.getRefundAmount().doubleValue();
        }
        d.refundTotal = round2(refundTotal);
        d.refundCount = refundsInScope.size();
        d.netSales = round2(total - refundTotal);

        // category + cost lookup from the relevant catalogue(s). Cost is the CURRENT item
        // costPrice (we don't freeze cost onto invoice_lines - see comment on the Profit tile).
        Map<String, String> categoryOf = new LinkedHashMap<>();
        Map<String, Double> costOf = new LinkedHashMap<>();
        for (Item it : items) {
            categoryOf.put(it.getId(), it.getCategory());
            costOf.put(it.getId(), it.getCostPrice() == null ? 0.0 : it.getCostPrice().doubleValue());
        }
        Map<String, Double> revenueByCategory = new LinkedHashMap<>();
        Map<String, Double> profitByCategory = new LinkedHashMap<>();
        double totalCogs = 0;             // cost of goods sold (only for lines with a positive cost)
        double coveredRevenue = 0;        // revenue on lines that HAD a cost - so margin % isn't skewed by zero-cost items
        boolean anyItemHasCost = false;
        for (Item it : items) {
            if (it.getCostPrice() != null && it.getCostPrice().signum() > 0) {
                anyItemHasCost = true;
                break;
            }
        }
        for (Invoice inv : invoices) {
            for (InvoiceLine line : inv.getLines()) {
                String cat = categoryOf.getOrDefault(line.getItemId(), "Other");
                double amount = line.getAmount().doubleValue();
                revenueByCategory.merge(cat, amount, Double::sum);
                double cost = costOf.getOrDefault(line.getItemId(), 0.0) * line.getQuantity();
                if (cost > 0) {
                    profitByCategory.merge(cat, amount - cost, Double::sum);
                    totalCogs += cost;
                    coveredRevenue += amount;
                }
            }
        }
        // Attribute refunds against cost as well - a returned item de-books both the revenue AND the cost.
        for (Refund r : refundsInScope) {
            for (InvoiceLine rl : r.getLines()) {
                double c = costOf.getOrDefault(rl.getItemId(), 0.0) * rl.getQuantity();
                if (c > 0) {
                    totalCogs -= c;
                    coveredRevenue -= rl.getAmount().doubleValue();
                }
            }
        }
        d.categoryRevenue = new ArrayList<>();
        revenueByCategory.entrySet().stream()
                .sorted((a, b) -> Double.compare(b.getValue(), a.getValue()))
                .limit(6)
                .forEach(e -> d.categoryRevenue.add(new Dtos.CategoryRevenueDto(e.getKey(), round2(e.getValue()))));

        d.categoryProfit = new ArrayList<>();
        profitByCategory.entrySet().stream()
                .sorted((a, b) -> Double.compare(b.getValue(), a.getValue()))
                .limit(6)
                .forEach(e -> d.categoryProfit.add(new Dtos.CategoryRevenueDto(e.getKey(), round2(e.getValue()))));

        // "Profit" is revenue-covered-by-a-known-cost minus that cost. When no items have a cost
        // set, profit stays zero and profitCoverage=0 so the UI can nudge the owner to set costs.
        d.profit = round2(coveredRevenue - totalCogs);
        d.cogs = round2(totalCogs);
        d.grossMarginPercent = coveredRevenue > 0 ? round2((coveredRevenue - totalCogs) / coveredRevenue * 100) : 0;
        d.profitCoverage = anyItemHasCost ? round2(coveredRevenue) : 0;   // revenue that had a known cost basis
        d.profitCoverableRevenue = round2(total - refundTotal);           // net revenue in scope (for the "X% covered" hint)

        d.branchRevenue = new ArrayList<>();
        if (branchId == null) {
            Map<String, double[]> byBranch = new LinkedHashMap<>(); // [amount, count]
            for (Invoice inv : invoices) {
                double[] agg = byBranch.computeIfAbsent(inv.getBranchId(), k -> new double[2]);
                agg[0] += inv.getGrandTotal().doubleValue();
                agg[1] += 1;
            }
            for (Branch b : ctx.branches().getAll()) {
                double[] agg = byBranch.getOrDefault(b.getId(), new double[2]);
                d.branchRevenue.add(new Dtos.BranchRevenueDto(b.getId(), b.getName(), round2(agg[0]), (int) agg[1]));
            }
            d.branchRevenue.sort((a, b) -> Double.compare(b.amount, a.amount));
        }

        d.lowStock = new ArrayList<>();
        for (Item it : items) {
            if (it.getStock() <= it.getReorderLevel()) {
                d.lowStock.add(new Dtos.LowStockDto(it.getId(), it.getBranchId(), it.getName(), it.getUnit(),
                        it.getStock(), it.getReorderLevel()));
            }
        }
        d.lowStock.sort((a, b) -> Double.compare(a.stock, b.stock));
        d.lowStockCount = d.lowStock.size();

        d.recentInvoices = new ArrayList<>();
        int n = 0;
        for (Invoice inv : invoices) { // already newest-first
            if (n++ >= 5) {
                break;
            }
            d.recentInvoices.add(new Dtos.RecentInvoiceDto(
                    inv.getInvoiceNo(),
                    Mappers.invoice(inv, ctx.branches()).dateTime,
                    inv.getCustomerName(),
                    inv.getGrandTotal().doubleValue()));
        }

        // Payment-mix breakdown: how the period's revenue split across Cash / Card / UPI.
        // Order the modes by amount so the biggest slice always leads the chart.
        Map<String, double[]> byMode = new LinkedHashMap<>(); // [count, amount]
        for (Invoice inv : invoices) {
            String mode = inv.getPaymentMode() == null || inv.getPaymentMode().isEmpty()
                    ? "Other" : inv.getPaymentMode();
            double[] agg = byMode.computeIfAbsent(mode, k -> new double[2]);
            agg[0] += 1;
            agg[1] += inv.getGrandTotal().doubleValue();
        }
        d.paymentMix = new ArrayList<>();
        byMode.entrySet().stream()
                .sorted((a, b) -> Double.compare(b.getValue()[1], a.getValue()[1]))
                .forEach(e -> d.paymentMix.add(new Dtos.PaymentBreakdownDto(
                        e.getKey(), (int) e.getValue()[0], round2(e.getValue()[1]))));

        // Top-selling items in the period, by revenue. The Z-report already computes this
        // for a whole day per branch; here we do it for whatever period + scope is active.
        Map<String, double[]> byItem = new LinkedHashMap<>(); // [qty, amount]
        Map<String, String> itemUnit = new LinkedHashMap<>();
        for (Invoice inv : invoices) {
            for (InvoiceLine line : inv.getLines()) {
                double[] agg = byItem.computeIfAbsent(line.getName(), k -> new double[2]);
                agg[0] += line.getQuantity();
                agg[1] += line.getAmount().doubleValue();
                itemUnit.putIfAbsent(line.getName(), line.getUnit());
            }
        }
        d.topItems = new ArrayList<>();
        byItem.entrySet().stream()
                .sorted((a, b) -> Double.compare(b.getValue()[1], a.getValue()[1]))
                .limit(5)
                .forEach(e -> d.topItems.add(new Dtos.TopItemDto(
                        e.getKey(), e.getValue()[0], itemUnit.get(e.getKey()), round2(e.getValue()[1]))));

        // "vs previous period" delta: sales in the immediately-preceding equal-length window.
        // Only meaningful when the period has finite bounds - all-time has no "before".
        d.previousNetSales = 0;
        LocalDate pFrom = parseDate(params.get("from"));
        LocalDate pTo = parseDate(params.get("to"));
        if (pFrom != null && pTo != null && !pTo.isBefore(pFrom)) {
            long days = java.time.temporal.ChronoUnit.DAYS.between(pFrom, pTo) + 1;
            LocalDate prevTo = pFrom.minusDays(1);
            LocalDate prevFrom = prevTo.minusDays(days - 1);
            List<Invoice> prevInv = branchId == null ? ctx.invoiceStore().getAll()
                    : ctx.invoiceStore().getAllForBranch(branchId);
            List<Refund> prevRef = branchId == null ? ctx.refunds().getAll()
                    : ctx.refunds().getAllForBranch(branchId);
            double prevTotal = 0, prevRefund = 0;
            for (Invoice inv : prevInv) {
                LocalDate day = inv.getDateTime().toLocalDate();
                if (!day.isBefore(prevFrom) && !day.isAfter(prevTo)) {
                    prevTotal += inv.getGrandTotal().doubleValue();
                }
            }
            for (Refund r : prevRef) {
                LocalDate day = r.getDateTime().toLocalDate();
                if (!day.isBefore(prevFrom) && !day.isAfter(prevTo)) {
                    prevRefund += r.getRefundAmount().doubleValue();
                }
            }
            d.previousNetSales = round2(prevTotal - prevRefund);
        }
        return d;
    }

    // ---------------- day-end Z-report ----------------

    /**
     * Builds the day-end reconciliation report every till needs at close-out:
     * invoice range, tax split (CGST/SGST), payment-mode breakdown, cash owed
     * in the drawer, and the top-selling items of the day.
     * <p>
     * Admin sees any branch (or all combined); Manager/Cashier is pinned to
     * their own branch, no matter what the query says.
     */
    private Dtos.ZReportDto buildZReport(HttpExchange ex, User user) throws IOException {
        Map<String, String> q = Http.queryParams(ex);
        LocalDate date = parseDate(q.get("date"));
        if (date == null) {
            date = Time.today();
        }
        String branchId = resolveBranchIdOrAll(ex, user);

        List<Invoice> all = branchId == null ? ctx.invoiceStore().getAll() : ctx.invoiceStore().getAllForBranch(branchId);
        List<Invoice> day = new ArrayList<>();
        for (Invoice inv : all) {
            if (inv.getDateTime().toLocalDate().equals(date)) {
                day.add(inv);
            }
        }
        // Oldest first for a sensible first/last invoice number pair.
        day.sort((a, b) -> a.getDateTime().compareTo(b.getDateTime()));

        Dtos.ZReportDto z = new Dtos.ZReportDto();
        z.date = date.toString();
        z.branchId = branchId;
        z.branchName = branchId == null ? "All Branches" : ctx.branches().require(branchId).getName();
        z.allBranches = branchId == null;
        z.invoiceCount = day.size();
        if (!day.isEmpty()) {
            z.firstInvoiceNo = day.get(0).getInvoiceNo();
            z.lastInvoiceNo = day.get(day.size() - 1).getInvoiceNo();
        }

        BigDecimal sub = BigDecimal.ZERO, discount = BigDecimal.ZERO, cgst = BigDecimal.ZERO;
        BigDecimal sgst = BigDecimal.ZERO, igst = BigDecimal.ZERO;
        BigDecimal roundOff = BigDecimal.ZERO, grand = BigDecimal.ZERO;
        BigDecimal cashSales = BigDecimal.ZERO, cashDrawer = BigDecimal.ZERO;
        Map<String, int[]> payCount = new LinkedHashMap<>();
        Map<String, BigDecimal> payAmount = new LinkedHashMap<>();
        Map<String, double[]> byItem = new LinkedHashMap<>(); // [qty, amount]
        Map<String, String> itemUnit = new LinkedHashMap<>();

        for (Invoice inv : day) {
            sub = sub.add(inv.getSubTotal());
            discount = discount.add(inv.getDiscount());
            cgst = cgst.add(inv.getCgst());
            sgst = sgst.add(inv.getSgst());
            igst = igst.add(inv.getIgst());
            roundOff = roundOff.add(inv.getRoundOff());
            grand = grand.add(inv.getGrandTotal());
            String mode = inv.getPaymentMode() == null || inv.getPaymentMode().isEmpty() ? "Other" : inv.getPaymentMode();
            payCount.computeIfAbsent(mode, k -> new int[1])[0]++;
            payAmount.merge(mode, inv.getGrandTotal(), BigDecimal::add);
            if (mode.equalsIgnoreCase("Cash")) {
                cashSales = cashSales.add(inv.getGrandTotal());
                // Cash the customer handed over stays in the drawer; the change we gave back leaves it.
                cashDrawer = cashDrawer.add(inv.getGrandTotal());
            }
            for (InvoiceLine line : inv.getLines()) {
                double[] agg = byItem.computeIfAbsent(line.getName(), k -> new double[2]);
                agg[0] += line.getQuantity();
                agg[1] += line.getAmount().doubleValue();
                itemUnit.putIfAbsent(line.getName(), line.getUnit());
            }
        }
        z.subTotal = sub.doubleValue();
        z.discount = discount.doubleValue();
        z.cgst = cgst.doubleValue();
        z.sgst = sgst.doubleValue();
        z.igst = igst.doubleValue();
        z.roundOff = roundOff.doubleValue();
        z.grandTotal = grand.doubleValue();
        z.cashSales = cashSales.doubleValue();

        // Refunds for the same day + branch scope. Money the store paid back leaves the drawer.
        List<Refund> refundsForDay = new ArrayList<>();
        List<Refund> allRefunds = branchId == null ? ctx.refunds().getAll() : ctx.refunds().getAllForBranch(branchId);
        for (Refund r : allRefunds) {
            if (r.getDateTime().toLocalDate().equals(date)) {
                refundsForDay.add(r);
            }
        }
        BigDecimal refundTotal = BigDecimal.ZERO;
        for (Refund r : refundsForDay) {
            refundTotal = refundTotal.add(r.getRefundAmount());
        }
        z.refundTotal = refundTotal.doubleValue();
        z.refundCount = refundsForDay.size();
        z.netSales = grand.subtract(refundTotal).doubleValue();
        // Refunds are paid back from the till, so they reduce cash-in-drawer for the day.
        z.cashInDrawer = cashDrawer.subtract(refundTotal).doubleValue();

        z.byPayment = new ArrayList<>();
        for (Map.Entry<String, BigDecimal> e : payAmount.entrySet()) {
            z.byPayment.add(new Dtos.PaymentBreakdownDto(e.getKey(),
                    payCount.get(e.getKey())[0], e.getValue().doubleValue()));
        }
        z.byPayment.sort((a, b) -> Double.compare(b.amount, a.amount));

        z.topItems = new ArrayList<>();
        byItem.entrySet().stream()
                .sorted((a, b) -> Double.compare(b.getValue()[1], a.getValue()[1]))
                .limit(10)
                .forEach(e -> z.topItems.add(new Dtos.TopItemDto(
                        e.getKey(), e.getValue()[0], itemUnit.get(e.getKey()), e.getValue()[1])));
        return z;
    }

    private List<Item> allItemsAcrossBranches() {
        List<Item> out = new ArrayList<>();
        for (Branch b : ctx.branches().getAll()) {
            out.addAll(ctx.inventory().getAll(b.getId()));
        }
        return out;
    }

    // ---------------- branch scoping & authorization helpers ----------------

    private void requireRole(User user, Role... allowed) {
        for (Role r : allowed) {
            if (user.getRole() == r) {
                return;
            }
        }
        throw ApiException.forbidden("You do not have permission to do that.");
    }

    /** Resolves to exactly one branch (never "all"). Non-admins are always pinned to their own branch. */
    private String resolveBranchId(HttpExchange ex, User user) throws IOException {
        if (user.getRole() != Role.ADMIN) {
            return user.getBranchId();
        }
        String requested = Http.queryParams(ex).get("branchId");
        if (requested == null || requested.isEmpty() || requested.equalsIgnoreCase("all")) {
            return ctx.branches().defaultBranchId();
        }
        ctx.branches().require(requested);
        return requested;
    }

    /** Same as {@link #resolveBranchId}, but reads the branch from a request-body field instead of the query string. */
    private String resolveBranchIdForBody(User user, String requestedBranchId) {
        if (user.getRole() != Role.ADMIN) {
            return user.getBranchId();
        }
        if (requestedBranchId == null || requestedBranchId.isEmpty()) {
            return ctx.branches().defaultBranchId();
        }
        ctx.branches().require(requestedBranchId);
        return requestedBranchId;
    }

    /** Like {@link #resolveBranchId}, but an ADMIN may explicitly ask for "all" (returns null) - reports only. */
    private String resolveBranchIdOrAll(HttpExchange ex, User user) throws IOException {
        if (user.getRole() != Role.ADMIN) {
            return user.getBranchId();
        }
        String requested = Http.queryParams(ex).get("branchId");
        if (requested == null || requested.isEmpty() || requested.equalsIgnoreCase("all")) {
            return null;
        }
        ctx.branches().require(requested);
        return requested;
    }

    /**
     * Keeps only invoices whose date falls within the inclusive {@code ?from=}/{@code ?to=}
     * window (both {@code yyyy-MM-dd}, either optional). A missing or unparseable bound is
     * treated as open-ended, so no filter at all returns every invoice unchanged.
     */
    private List<Invoice> filterByDate(HttpExchange ex, List<Invoice> invoices) {
        Map<String, String> q = Http.queryParams(ex);
        LocalDate from = parseDate(q.get("from"));
        LocalDate to = parseDate(q.get("to"));
        if (from == null && to == null) {
            return invoices;
        }
        List<Invoice> out = new ArrayList<>();
        for (Invoice inv : invoices) {
            LocalDate day = inv.getDateTime().toLocalDate();
            if (from != null && day.isBefore(from)) {
                continue;
            }
            if (to != null && day.isAfter(to)) {
                continue;
            }
            out.add(inv);
        }
        return out;
    }

    private LocalDate parseDate(String s) {
        if (s == null || s.trim().isEmpty()) {
            return null;
        }
        try {
            return LocalDate.parse(s.trim());
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** Echoes a valid {@code yyyy-MM-dd} bound back to the client, or {@code null} if absent/invalid. */
    private String normaliseDate(String s) {
        LocalDate d = parseDate(s);
        return d == null ? null : d.toString();
    }

    private String nullToEmpty(String s) {
        return Text.oneLine(s);
    }

    private Map<String, Object> ok() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        return m;
    }

    private double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
