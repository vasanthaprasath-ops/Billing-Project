package grocery.service;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static java.nio.file.StandardCopyOption.REPLACE_EXISTING;

/**
 * Admin "restore from backup" using a deliberately safe stage-then-restart flow.
 * <p>
 * The live database is a single connection held open for the whole process, and every
 * service caches its table in memory at startup - so swapping the file out from under a
 * running server would both fight the OS file lock and leave the caches pointing at data
 * that no longer exists. Instead, {@link #stage} validates the uploaded backup and parks it
 * as {@code data/restore-pending.db}; {@link #applyPendingIfAny} (called once at boot, before
 * the DB is opened) copies the current data aside for safety, swaps the staged file into
 * place, and clears the marker. The admin is told to restart to complete the restore.
 */
public final class SqliteRestore {

    static final String PENDING_DB = "restore-pending.db";
    static final String PENDING_PROPS = "restore-pending.properties";

    /** Tables a genuine FreshMart backup must contain - guards against restoring a random SQLite file. */
    private static final String[] REQUIRED_TABLES = {
            "branches", "items", "users", "invoices", "invoice_lines", "refunds", "refund_lines", "audit_log"
    };

    // The 16-byte SQLite file header: "SQLite format 3" followed by a NUL terminator.
    private static final byte[] SQLITE_MAGIC = {
            'S', 'Q', 'L', 'i', 't', 'e', ' ', 'f', 'o', 'r', 'm', 'a', 't', ' ', '3', 0
    };

    private SqliteRestore() {
    }

    /**
     * Validate an uploaded backup zip (the same shape {@code /api/admin/backup} produces) and
     * park its {@code freshmart.db} - and {@code store.properties} if present - as pending. Throws
     * {@link IllegalArgumentException} (-> HTTP 400) if the zip isn't a valid FreshMart backup.
     *
     * @return a short human-readable summary of what was staged
     */
    public static String stage(File dataDir, byte[] zipBytes) throws IOException {
        byte[] dbBytes = null;
        byte[] propsBytes = null;
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                // Entry names are matched as exact literals and never used as a path, so there
                // is no zip-slip surface here.
                if ("freshmart.db".equals(entry.getName())) {
                    dbBytes = zis.readAllBytes();
                } else if ("store.properties".equals(entry.getName())) {
                    propsBytes = zis.readAllBytes();
                }
            }
        }
        if (dbBytes == null) {
            throw new IllegalArgumentException("That zip is not a FreshMart backup (no freshmart.db inside).");
        }
        if (!looksLikeSqlite(dbBytes)) {
            throw new IllegalArgumentException("The freshmart.db in that zip is not a valid SQLite database.");
        }

        File scratch = File.createTempFile("freshmart-restore-", ".db");
        boolean staged = false;
        try {
            Files.write(scratch.toPath(), dbBytes);
            validateSchema(scratch);
            Files.move(scratch.toPath(), new File(dataDir, PENDING_DB).toPath(), REPLACE_EXISTING);
            staged = true;
        } finally {
            if (!staged) {
                scratch.delete();
            }
        }

        File pendingProps = new File(dataDir, PENDING_PROPS);
        if (propsBytes != null) {
            Files.write(pendingProps.toPath(), propsBytes);
        } else {
            pendingProps.delete();
        }
        return dbBytes.length + " byte database" + (propsBytes != null ? " + store.properties" : "") + " staged";
    }

    /**
     * If a restore was staged, apply it now: keep a safety copy of the current data, swap the
     * staged database (and store.properties, if staged) into place, and clear the marker. Runs
     * at boot before the DB is opened, so it uses {@code System.out}/{@code err} (logging isn't up yet).
     */
    public static void applyPendingIfAny(File dataDir, File dbFile, File storeFile) {
        File pendingDb = new File(dataDir, PENDING_DB);
        if (!pendingDb.isFile()) {
            return;
        }
        File pendingProps = new File(dataDir, PENDING_PROPS);
        try {
            File safety = new File(new File(dataDir, "backups"),
                    "pre-restore-" + new SimpleDateFormat("yyyyMMdd-HHmmss").format(new Date()));
            safety.mkdirs();
            if (dbFile.isFile()) {
                Files.copy(dbFile.toPath(), new File(safety, "freshmart.db").toPath(), REPLACE_EXISTING);
            }
            if (storeFile.isFile()) {
                Files.copy(storeFile.toPath(), new File(safety, "store.properties").toPath(), REPLACE_EXISTING);
            }
            // Stale WAL/SHM sidecars belong to the OLD database - drop them so the restored file opens clean.
            new File(dbFile.getPath() + "-wal").delete();
            new File(dbFile.getPath() + "-shm").delete();

            Files.move(pendingDb.toPath(), dbFile.toPath(), REPLACE_EXISTING);
            if (pendingProps.isFile()) {
                Files.move(pendingProps.toPath(), storeFile.toPath(), REPLACE_EXISTING);
            }
            System.out.println("  Restore applied from staged backup (previous data saved in "
                    + safety.getPath() + ").");
        } catch (IOException | RuntimeException e) {
            System.err.println("  RESTORE FAILED to apply staged backup: " + e.getMessage()
                    + " - starting with existing data. The staged file has been set aside.");
            // Move the offending file aside so a bad stage can't wedge every future boot.
            pendingDb.renameTo(new File(dataDir, PENDING_DB + ".failed"));
        }
    }

    private static boolean looksLikeSqlite(byte[] bytes) {
        if (bytes.length < SQLITE_MAGIC.length) {
            return false;
        }
        for (int i = 0; i < SQLITE_MAGIC.length; i++) {
            if (bytes[i] != SQLITE_MAGIC[i]) {
                return false;
            }
        }
        return true;
    }

    private static void validateSchema(File dbFile) {
        String url = "jdbc:sqlite:" + dbFile.getPath();
        try (Connection c = DriverManager.getConnection(url);
             Statement st = c.createStatement()) {
            try (ResultSet rs = st.executeQuery("PRAGMA integrity_check")) {
                if (!rs.next() || !"ok".equalsIgnoreCase(rs.getString(1))) {
                    throw new IllegalArgumentException("Backup database failed its integrity check.");
                }
            }
            Set<String> tables = new HashSet<>();
            try (ResultSet rs = st.executeQuery("SELECT name FROM sqlite_master WHERE type='table'")) {
                while (rs.next()) {
                    tables.add(rs.getString(1).toLowerCase());
                }
            }
            for (String required : REQUIRED_TABLES) {
                if (!tables.contains(required)) {
                    throw new IllegalArgumentException(
                            "That backup is missing the '" + required + "' table - it isn't a FreshMart backup.");
                }
            }
        } catch (SQLException e) {
            throw new IllegalArgumentException("Could not read that backup database: " + e.getMessage());
        }
    }
}
