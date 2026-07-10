package grocery.service;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import grocery.model.AuditEntry;
import grocery.model.Branch;
import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.model.Item;
import grocery.model.Refund;
import grocery.model.User;
import grocery.util.AtomicFile;
import grocery.util.Db;
import grocery.util.Money;

/**
 * One-time import of a pre-SQLite {@code data/} folder (8 CSV files) into a
 * fresh {@code freshmart.db}. Runs at most once per install: if the db file
 * already exists, or no legacy CSVs exist (brand new install), this is a
 * no-op and every service seeds itself directly into SQLite instead.
 * <p>
 * Sequencing that makes a crash mid-migration safe to just retry:
 * the new database is built entirely at a scratch path
 * ({@code freshmart.db.migrating}), and only atomically renamed into place
 * ({@link AtomicFile#commit}) after every row has been imported and
 * committed. The original CSVs are moved (never deleted) into
 * {@code data/legacy_csv_backup/} only after that rename succeeds - so a
 * crash at any point before that leaves either no db file yet (next startup
 * just retries against the still-untouched CSVs) or a fully migrated one.
 */
public final class SqliteMigration {

    private static final String[] LEGACY_FILE_NAMES = {
            "branches.csv", "items.csv", "users.csv", "audit_log.csv",
            "invoices.csv", "invoice_lines.csv", "refunds.csv", "refund_lines.csv"
    };

    private SqliteMigration() {
    }

    public static void migrateIfNeeded(File dataDir, File finalDbFile) {
        if (finalDbFile.exists()) {
            return; // already migrated (or a fresh SQLite-native install)
        }
        boolean anyLegacy = false;
        for (String name : LEGACY_FILE_NAMES) {
            if (new File(dataDir, name).exists()) {
                anyLegacy = true;
                break;
            }
        }
        if (!anyLegacy) {
            return; // brand new install - services will self-seed straight into SQLite
        }

        System.out.println();
        System.out.println("  Migrating existing CSV data into freshmart.db ...");

        File tempDb = new File(dataDir, "freshmart.db.migrating");
        if (tempDb.exists() && !tempDb.delete()) {
            throw new RuntimeException("Could not clear stale " + tempDb + " before migration.");
        }

        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException e) {
            throw new RuntimeException("sqlite-jdbc driver not found on classpath", e);
        }

        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + tempDb.getPath())) {
            Db.createSchema(conn);
            try (Statement st = conn.createStatement()) {
                // Real legacy data may have harmless referential slack (e.g. an item
                // referencing a since-deleted branch) - don't fail the whole migration over it.
                st.execute("PRAGMA foreign_keys=OFF");
            }

            List<Branch> branches = BranchService.parseLegacyCsv(new File(dataDir, "branches.csv"));
            String defaultBranchId = branches.isEmpty() ? "BR-001" : branches.get(0).getId();
            List<Item> items = InventoryService.parseLegacyCsv(new File(dataDir, "items.csv"), defaultBranchId);
            List<User> users = UserService.parseLegacyCsv(new File(dataDir, "users.csv"));
            List<Invoice> invoices = InvoiceStore.parseLegacyCsv(
                    new File(dataDir, "invoices.csv"), new File(dataDir, "invoice_lines.csv"), defaultBranchId);
            List<Refund> refunds = RefundService.parseLegacyCsv(
                    new File(dataDir, "refunds.csv"), new File(dataDir, "refund_lines.csv"));
            List<AuditEntry> auditEntries = AuditLogService.parseLegacyCsv(new File(dataDir, "audit_log.csv"));

            conn.setAutoCommit(false);
            try {
                for (Branch b : branches) {
                    insertBranch(conn, b);
                }
                for (Item it : items) {
                    insertItem(conn, it);
                }
                for (User u : users) {
                    insertUser(conn, u);
                }
                for (Invoice inv : invoices) {
                    insertInvoiceHeader(conn, inv);
                    for (InvoiceLine line : inv.getLines()) {
                        insertInvoiceLine(conn, inv.getInvoiceNo(), line);
                    }
                }
                for (Refund r : refunds) {
                    insertRefundHeader(conn, r);
                    for (InvoiceLine line : r.getLines()) {
                        insertRefundLine(conn, r.getRefundNo(), line);
                    }
                }
                for (AuditEntry e : auditEntries) {
                    insertAuditEntry(conn, e);
                }
                conn.commit();
            } catch (SQLException | RuntimeException e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(true);
            }

            System.out.println("    branches      : " + branches.size());
            System.out.println("    items         : " + items.size());
            System.out.println("    users         : " + users.size());
            System.out.println("    invoices      : " + invoices.size());
            System.out.println("    refunds       : " + refunds.size());
            System.out.println("    audit entries : " + auditEntries.size());
        } catch (SQLException e) {
            throw new RuntimeException("SQLite migration failed: " + e.getMessage(), e);
        }

        try {
            AtomicFile.commit(tempDb, finalDbFile);
        } catch (IOException e) {
            throw new RuntimeException("Could not finalize migrated database: " + e.getMessage(), e);
        }

        File backupDir = new File(dataDir, "legacy_csv_backup");
        backupDir.mkdirs();
        for (String name : LEGACY_FILE_NAMES) {
            File src = new File(dataDir, name);
            if (!src.exists()) {
                continue;
            }
            try {
                Files.move(src.toPath(), new File(backupDir, name).toPath(), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException e) {
                grocery.util.Log.warn("Could not move legacy file " + name + " into legacy_csv_backup/: "
                        + e.getMessage(), e);
            }
        }

        System.out.println("  Migration complete. Original CSVs preserved in data/legacy_csv_backup/.");
        System.out.println();
    }

    private static void insertBranch(Connection conn, Branch b) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO branches(id, name, addressLine1, addressLine2, phone, gstin, active) " +
                        "VALUES(?,?,?,?,?,?,?)")) {
            ps.setString(1, b.getId());
            ps.setString(2, b.getName());
            ps.setString(3, b.getAddressLine1());
            ps.setString(4, b.getAddressLine2());
            ps.setString(5, b.getPhone());
            ps.setString(6, b.getGstin());
            ps.setInt(7, b.isActive() ? 1 : 0);
            ps.executeUpdate();
        }
    }

    private static void insertItem(Connection conn, Item it) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO items(id, branchId, name, category, unit, price, taxRatePercent, stock, " +
                        "barcode, reorderLevel) VALUES(?,?,?,?,?,?,?,?,?,?)")) {
            ps.setString(1, it.getId());
            ps.setString(2, it.getBranchId());
            ps.setString(3, it.getName());
            ps.setString(4, it.getCategory());
            ps.setString(5, it.getUnit());
            ps.setString(6, Money.format(it.getPrice()));
            ps.setDouble(7, it.getTaxRatePercent());
            ps.setDouble(8, it.getStock());
            ps.setString(9, it.getBarcode());
            ps.setDouble(10, it.getReorderLevel());
            ps.executeUpdate();
        }
    }

    private static void insertUser(Connection conn, User u) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO users(username, passwordHash, fullName, role, branchId, active, " +
                        "mustChangePassword) VALUES(?,?,?,?,?,?,?)")) {
            ps.setString(1, u.getUsername());
            ps.setString(2, u.getPasswordHash());
            ps.setString(3, u.getFullName());
            ps.setString(4, u.getRole().name());
            ps.setString(5, u.getBranchId());
            ps.setInt(6, u.isActive() ? 1 : 0);
            ps.setInt(7, u.isMustChangePassword() ? 1 : 0);
            ps.executeUpdate();
        }
    }

    private static void insertInvoiceHeader(Connection conn, Invoice inv) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO invoices(invoiceNo, branchId, cashierUsername, dateTime, customerName, " +
                        "customerPhone, paymentMode, subTotal, discount, totalTax, grandTotal, amountPaid) " +
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")) {
            ps.setString(1, inv.getInvoiceNo());
            ps.setString(2, inv.getBranchId());
            ps.setString(3, inv.getCashierUsername());
            ps.setString(4, inv.getDateTime().format(java.time.format.DateTimeFormatter.ofPattern(
                    "yyyy-MM-dd'T'HH:mm:ss")));
            ps.setString(5, inv.getCustomerName());
            ps.setString(6, inv.getCustomerPhone());
            ps.setString(7, inv.getPaymentMode());
            ps.setString(8, Money.format(inv.getSubTotal()));
            ps.setString(9, Money.format(inv.getDiscount()));
            ps.setString(10, Money.format(inv.getTotalTax()));
            ps.setString(11, Money.format(inv.getGrandTotal()));
            ps.setString(12, Money.format(inv.getAmountPaid()));
            ps.executeUpdate();
        }
    }

    private static void insertInvoiceLine(Connection conn, String invoiceNo, InvoiceLine line) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO invoice_lines(invoiceNo, itemId, name, unit, price, taxRatePercent, quantity, " +
                        "amount, tax) VALUES(?,?,?,?,?,?,?,?,?)")) {
            ps.setString(1, invoiceNo);
            ps.setString(2, line.getItemId());
            ps.setString(3, line.getName());
            ps.setString(4, line.getUnit());
            ps.setString(5, Money.format(line.getPrice()));
            ps.setDouble(6, line.getTaxRatePercent());
            ps.setDouble(7, line.getQuantity());
            ps.setString(8, Money.format(line.getAmount()));
            ps.setString(9, Money.format(line.getTax()));
            ps.executeUpdate();
        }
    }

    private static void insertRefundHeader(Connection conn, Refund r) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO refunds(refundNo, originalInvoiceNo, branchId, cashierUsername, dateTime, " +
                        "refundAmount, refundTax, reason) VALUES(?,?,?,?,?,?,?,?)")) {
            ps.setString(1, r.getRefundNo());
            ps.setString(2, r.getOriginalInvoiceNo());
            ps.setString(3, r.getBranchId());
            ps.setString(4, r.getCashierUsername());
            ps.setString(5, r.getDateTime().format(java.time.format.DateTimeFormatter.ofPattern(
                    "yyyy-MM-dd'T'HH:mm:ss")));
            ps.setString(6, Money.format(r.getRefundAmount()));
            ps.setString(7, Money.format(r.getRefundTax()));
            ps.setString(8, r.getReason());
            ps.executeUpdate();
        }
    }

    private static void insertRefundLine(Connection conn, String refundNo, InvoiceLine line) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO refund_lines(refundNo, itemId, name, unit, price, taxRatePercent, quantity, " +
                        "amount, tax) VALUES(?,?,?,?,?,?,?,?,?)")) {
            ps.setString(1, refundNo);
            ps.setString(2, line.getItemId());
            ps.setString(3, line.getName());
            ps.setString(4, line.getUnit());
            ps.setString(5, Money.format(line.getPrice()));
            ps.setDouble(6, line.getTaxRatePercent());
            ps.setDouble(7, line.getQuantity());
            ps.setString(8, Money.format(line.getAmount()));
            ps.setString(9, Money.format(line.getTax()));
            ps.executeUpdate();
        }
    }

    private static void insertAuditEntry(Connection conn, AuditEntry e) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO audit_log(\"when\", username, role, branchId, action, details) " +
                        "VALUES(?,?,?,?,?,?)")) {
            ps.setString(1, e.getWhen().format(java.time.format.DateTimeFormatter.ofPattern(
                    "yyyy-MM-dd'T'HH:mm:ss")));
            ps.setString(2, e.getUsername());
            ps.setString(3, e.getRole() == null ? null : e.getRole().name());
            ps.setString(4, e.getBranchId());
            ps.setString(5, e.getAction());
            ps.setString(6, e.getDetails());
            ps.executeUpdate();
        }
    }
}
