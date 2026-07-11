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
    private final File dbFile;
    /**
     * Depth of nested {@link #inTransaction} calls. Guarded by the same monitor
     * as every other Db method, so no concurrent reader can see it half-updated.
     * Non-zero means an outer transaction is in flight and nested calls must
     * NOT commit/rollback themselves - the outermost frame owns the boundary.
     */
    private int transactionDepth;
    /**
     * Actions queued via {@link #afterCommit} while a transaction is in flight.
     * They run (in order) only if the OUTERMOST transaction commits, and are
     * discarded on rollback - so an in-memory cache update deferred here mirrors
     * a committed DB write exactly, and never lingers after a rolled-back one.
     * Guarded by the same monitor as every other Db method.
     */
    private final List<Runnable> afterCommitActions = new ArrayList<>();

    private Db(Connection conn, File dbFile) {
        this.conn = conn;
        this.dbFile = dbFile;
    }

    public static Db open(File dbFile) throws SQLException {
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException e) {
            throw new SQLException("sqlite-jdbc driver not found on classpath", e);
        }
        Connection conn = DriverManager.getConnection("jdbc:sqlite:" + dbFile.getPath());
        Db db = new Db(conn, dbFile);
        db.configure();
        createSchema(conn);
        return db;
    }

    /** The on-disk path of this database. Used by {@code BackupService} to open its own
     *  short-lived read-only connection so {@code VACUUM INTO} doesn't block the till. */
    public File file() {
        return dbFile;
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
                    "reorderLevel REAL NOT NULL DEFAULT 0, " +
                    "costPrice TEXT NOT NULL DEFAULT '0.00')");
            st.execute("CREATE INDEX IF NOT EXISTS idx_items_branchId ON items(branchId)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_items_branch_barcode ON items(branchId, barcode)");
            // Idempotent additive migration for older DBs. SQLite ALTER TABLE ADD COLUMN fails
            // cleanly with "duplicate column name" if it's already there; we swallow that so a
            // fresh DB (created above with the column already) and an old one converge.
            addColumnIfMissing(st, "items", "costPrice", "TEXT NOT NULL DEFAULT '0.00'");

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
            // Z-report groups sales by cashier at the end of every shift - without this
            // index that turns into a full-table scan once a store has ~100k invoices.
            st.execute("CREATE INDEX IF NOT EXISTS idx_invoices_cashier ON invoices(cashierUsername)");

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
            // "Top items by revenue" and refund-remaining calculations both filter by itemId.
            st.execute("CREATE INDEX IF NOT EXISTS idx_invoice_lines_itemId ON invoice_lines(itemId)");

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
            st.execute("CREATE INDEX IF NOT EXISTS idx_refund_lines_itemId ON refund_lines(itemId)");
            st.execute("CREATE INDEX IF NOT EXISTS idx_refunds_dateTime ON refunds(dateTime)");

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

    /**
     * Additive migration helper. SQLite has no {@code ADD COLUMN IF NOT EXISTS} - it fails with
     * "duplicate column name" if the column is already there. We catch that specific case and
     * swallow it so fresh DBs (with the column baked into the CREATE) and older DBs (adding it
     * via ALTER) converge silently.
     */
    private static void addColumnIfMissing(Statement st, String table, String column, String typeDdl)
            throws SQLException {
        try {
            st.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + typeDdl);
        } catch (SQLException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage().toLowerCase();
            if (!msg.contains("duplicate column name")) {
                throw e;
            }
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
     * {@link #query}/{@link #update}/nested {@link #inTransaction} from inside
     * {@code body} on the same thread (Java monitors are reentrant, and this
     * method is nest-aware: a nested call just runs the body inline and lets
     * the outermost frame decide whether to commit or roll back).
     */
    public synchronized void inTransaction(Runnable body) {
        if (transactionDepth > 0) {
            // Already inside an outer transaction - piggyback on its commit/rollback.
            // A RuntimeException here still propagates, and because the outer frame
            // sees it and rolls back, this nested unit is atomic with the outer one.
            transactionDepth++;
            try {
                body.run();
            } finally {
                transactionDepth--;
            }
            return;
        }
        boolean committed = false;
        try {
            conn.setAutoCommit(false);
            transactionDepth = 1;
            try {
                body.run();
                conn.commit();
                committed = true;
            } catch (RuntimeException e) {
                conn.rollback();
                throw e;
            } finally {
                transactionDepth = 0;
                conn.setAutoCommit(true);
            }
        } catch (SQLException e) {
            throw new RuntimeException("Transaction failed: " + e.getMessage(), e);
        } finally {
            fireAfterCommit(committed);
        }
    }

    /**
     * Register an action to run once the OUTERMOST transaction commits. If called
     * outside any transaction the action runs immediately (the write is already
     * durable). If the transaction rolls back, the action is discarded and never
     * runs. Use this for an in-memory cache update that must mirror a committed DB
     * write - deferring it past commit is what keeps the cache and the DB in
     * lockstep even when the enclosing transaction is a nested checkout/refund
     * that rolls back after the cache would otherwise have been mutated.
     */
    public synchronized void afterCommit(Runnable action) {
        if (transactionDepth == 0) {
            action.run();
        } else {
            afterCommitActions.add(action);
        }
    }

    /** Runs queued after-commit hooks if we committed, else drops them. Always clears the queue. */
    private void fireAfterCommit(boolean committed) {
        if (afterCommitActions.isEmpty()) {
            return;
        }
        List<Runnable> pending = new ArrayList<>(afterCommitActions);
        afterCommitActions.clear();
        if (!committed) {
            return; // rolled back - the cache was never touched, so there is nothing to apply
        }
        for (Runnable action : pending) {
            try {
                action.run();
            } catch (RuntimeException e) {
                Log.warn("after-commit hook failed: " + e.getMessage(), e);
            }
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
