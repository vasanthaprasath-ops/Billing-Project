package grocery.util;

import java.io.File;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * The single shared SQLite connection for the whole app.
 * <p>
 * Every JDBC call funnels through this class's {@code synchronized} methods.
 * A raw {@link Connection} is not documented as safe for concurrent use from
 * multiple threads (each service class only guards its own business logic
 * with its own monitor, and two different services' methods can run truly
 * concurrently) - so this lock exists purely to serialize access to the
 * connection itself, on top of, not instead of, every service's existing
 * per-instance synchronization. Java intrinsic locks are reentrant, so a
 * service method already inside {@link #inTransaction} can freely call
 * {@link #query}/{@link #update} on the same thread without deadlocking.
 */
public final class Db {

    private final Connection conn;

    private Db(Connection conn) {
        this.conn = conn;
    }

    public static Db open(File dbFile) throws SQLException {
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException e) {
            throw new SQLException("sqlite-jdbc driver not found on classpath", e);
        }
        Connection conn = DriverManager.getConnection("jdbc:sqlite:" + dbFile.getPath());
        Db db = new Db(conn);
        db.configure();
        createSchema(conn);
        return db;
    }

    private void configure() throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("PRAGMA journal_mode=WAL");
            st.execute("PRAGMA synchronous=NORMAL");
            st.execute("PRAGMA busy_timeout=5000");
            st.execute("PRAGMA foreign_keys=ON");
        }
    }

    /**
     * Runs every {@code CREATE TABLE IF NOT EXISTS} / index statement against
     * any connection. Shared as a static entry point so the one-time CSV
     * import ({@code SqliteMigration}) can build an identical schema on its
     * own scratch connection (which deliberately uses different pragmas -
     * no WAL, {@code foreign_keys=OFF} - without duplicating this DDL).
     */
    public static void createSchema(Connection conn) throws SQLException {
        try (Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE IF NOT EXISTS branches (" +
                    "id TEXT PRIMARY KEY, " +
                    "name TEXT NOT NULL, " +
                    "addressLine1 TEXT NOT NULL DEFAULT '', " +
                    "addressLine2 TEXT NOT NULL DEFAULT '', " +
                    "phone TEXT NOT NULL DEFAULT '', " +
                    "gstin TEXT NOT NULL DEFAULT '', " +
                    "active INTEGER NOT NULL DEFAULT 1)");

            st.execute("CREATE TABLE IF NOT EXISTS items (" +
                    "id TEXT PRIMARY KEY, " +
                    "branchId TEXT NOT NULL REFERENCES branches(id), " +
                    "name TEXT NOT NULL, " +
                    "category TEXT NOT NULL DEFAULT '', " +
                    "unit TEXT NOT NULL DEFAULT '', " +
                    "price TEXT NOT NULL, " +
                    "taxRatePercent REAL NOT NULL DEFAULT 0, " +
                    "stock REAL NOT NULL DEFAULT 0, " +
                    "barcode TEXT NOT NULL DEFAULT '', " +
                    "reorderLevel REAL NOT NULL DEFAULT 0)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_items_branchId ON items(branchId)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_items_branch_barcode ON items(branchId, barcode)");

            st.execute("CREATE TABLE IF NOT EXISTS users (" +
                    "username TEXT PRIMARY KEY, " +
                    "passwordHash TEXT NOT NULL, " +
                    "fullName TEXT NOT NULL, " +
                    "role TEXT NOT NULL, " +
                    "branchId TEXT REFERENCES branches(id), " +
                    "active INTEGER NOT NULL DEFAULT 1, " +
                    "mustChangePassword INTEGER NOT NULL DEFAULT 0)");

            st.execute("CREATE TABLE IF NOT EXISTS invoices (" +
                    "invoiceNo TEXT PRIMARY KEY, " +
                    "branchId TEXT NOT NULL REFERENCES branches(id), " +
                    "cashierUsername TEXT NOT NULL, " +
                    "dateTime TEXT NOT NULL, " +
                    "customerName TEXT NOT NULL DEFAULT '', " +
                    "customerPhone TEXT NOT NULL DEFAULT '', " +
                    "paymentMode TEXT NOT NULL DEFAULT '', " +
                    "subTotal TEXT NOT NULL, " +
                    "discount TEXT NOT NULL, " +
                    "totalTax TEXT NOT NULL, " +
                    "grandTotal TEXT NOT NULL, " +
                    "amountPaid TEXT NOT NULL)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_invoices_branchId ON invoices(branchId)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_invoices_dateTime ON invoices(dateTime)");

            st.execute("CREATE TABLE IF NOT EXISTS invoice_lines (" +
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                    "invoiceNo TEXT NOT NULL REFERENCES invoices(invoiceNo) ON DELETE CASCADE, " +
                    "itemId TEXT NOT NULL, " +
                    "name TEXT NOT NULL, " +
                    "unit TEXT NOT NULL, " +
                    "price TEXT NOT NULL, " +
                    "taxRatePercent REAL NOT NULL, " +
                    "quantity REAL NOT NULL, " +
                    "amount TEXT NOT NULL, " +
                    "tax TEXT NOT NULL)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoiceNo ON invoice_lines(invoiceNo)");

            st.execute("CREATE TABLE IF NOT EXISTS refunds (" +
                    "refundNo TEXT PRIMARY KEY, " +
                    "originalInvoiceNo TEXT NOT NULL REFERENCES invoices(invoiceNo), " +
                    "branchId TEXT NOT NULL REFERENCES branches(id), " +
                    "cashierUsername TEXT NOT NULL, " +
                    "dateTime TEXT NOT NULL, " +
                    "refundAmount TEXT NOT NULL, " +
                    "refundTax TEXT NOT NULL, " +
                    "reason TEXT NOT NULL DEFAULT '')");
            st.execute("CREATE INDEX IF NOT EXISTS idx_refunds_originalInvoiceNo ON refunds(originalInvoiceNo)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_refunds_branchId ON refunds(branchId)");

            st.execute("CREATE TABLE IF NOT EXISTS refund_lines (" +
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                    "refundNo TEXT NOT NULL REFERENCES refunds(refundNo) ON DELETE CASCADE, " +
                    "itemId TEXT NOT NULL, " +
                    "name TEXT NOT NULL, " +
                    "unit TEXT NOT NULL, " +
                    "price TEXT NOT NULL, " +
                    "taxRatePercent REAL NOT NULL, " +
                    "quantity REAL NOT NULL, " +
                    "amount TEXT NOT NULL, " +
                    "tax TEXT NOT NULL)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_refund_lines_refundNo ON refund_lines(refundNo)");

            st.execute("CREATE TABLE IF NOT EXISTS audit_log (" +
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                    "\"when\" TEXT NOT NULL, " +
                    "username TEXT NOT NULL, " +
                    "role TEXT, " +
                    "branchId TEXT, " +
                    "action TEXT NOT NULL, " +
                    "details TEXT NOT NULL DEFAULT '')");
            st.execute("CREATE INDEX IF NOT EXISTS idx_audit_log_when ON audit_log(\"when\")");
        }
    }

    /** Read query with no bind parameters. */
    public synchronized <T> List<T> query(String sql, RowMapper<T> mapper) {
        return query(sql, ps -> { }, mapper);
    }

    /** Read query, binding parameters via {@code binder} and mapping each row via {@code mapper}. */
    public synchronized <T> List<T> query(String sql, SqlConsumer<PreparedStatement> binder, RowMapper<T> mapper) {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            binder.accept(ps);
            try (ResultSet rs = ps.executeQuery()) {
                List<T> out = new ArrayList<>();
                while (rs.next()) {
                    out.add(mapper.map(rs));
                }
                return out;
            }
        } catch (SQLException e) {
            throw new RuntimeException("Database query failed: " + e.getMessage(), e);
        }
    }

    /** INSERT/UPDATE/DELETE with no bind parameters. Returns rows affected. */
    public synchronized int update(String sql) {
        return update(sql, ps -> { });
    }

    /** INSERT/UPDATE/DELETE, binding parameters via {@code binder}. Returns rows affected. */
    public synchronized int update(String sql, SqlConsumer<PreparedStatement> binder) {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            binder.accept(ps);
            return ps.executeUpdate();
        } catch (SQLException e) {
            throw new RuntimeException("Database update failed: " + e.getMessage(), e);
        }
    }

    /** Run a plain statement with no result (DDL, PRAGMA, VACUUM INTO, etc). */
    public synchronized void exec(String sql) {
        try (Statement st = conn.createStatement()) {
            st.execute(sql);
        } catch (SQLException e) {
            throw new RuntimeException("Database statement failed: " + e.getMessage(), e);
        }
    }

    /**
     * Run {@code body} as one atomic transaction: commits only if it returns
     * normally, rolls back entirely if it throws. Safe to call
     * {@link #query}/{@link #update} from inside {@code body} on the same
     * thread (reentrant lock).
     */
    public synchronized void inTransaction(Runnable body) {
        try {
            conn.setAutoCommit(false);
            try {
                body.run();
                conn.commit();
            } catch (RuntimeException e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Transaction failed: " + e.getMessage(), e);
        }
    }

    public synchronized void close() {
        try {
            conn.close();
        } catch (SQLException ignore) {
            // shutting down anyway
        }
    }

    @FunctionalInterface
    public interface SqlConsumer<T> {
        void accept(T t) throws SQLException;
    }

    @FunctionalInterface
    public interface RowMapper<T> {
        T map(ResultSet rs) throws SQLException;
    }
}
