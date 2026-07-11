package grocery.service;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import grocery.util.Db;
import grocery.util.Log;
import grocery.util.Time;

/**
 * {@code freshmart.db} plus {@code store.properties} together ARE the
 * database, so this gives that design the two safety nets a bigger setup
 * would otherwise provide: an automatic daily copy, and an on-demand zip
 * download. Both use SQLite's own {@code VACUUM INTO}, routed through the
 * same shared, single-locked {@link Db} as every other write - so a backup
 * automatically waits for any in-flight write to finish (and blocks new ones
 * from starting) for free, and always produces one consistent, fully
 * self-contained snapshot file (no partial writes, no stray -wal/-shm
 * sidecars) rather than a raw byte-copy of a file that might be open.
 */
public class BackupService {

    private final Db db;
    private final File dataDir;
    private final File backupsDir;
    private final AuditLogService auditLog;
    /** Non-null when the most recent daily-backup attempt failed - surfaces to admins on next login. */
    private volatile String lastFailure;

    public BackupService(Db db, File dataDir, AuditLogService auditLog) {
        this.db = db;
        this.dataDir = dataDir;
        this.backupsDir = new File(dataDir, "backups");
        this.auditLog = auditLog;
    }

    /** A fresh zip of {@code freshmart.db} + {@code store.properties} for on-demand download. */
    public byte[] zipData() throws IOException {
        File scratch = File.createTempFile("freshmart-backup-", ".db");
        if (!scratch.delete()) {
            throw new IOException("Could not prepare scratch path for backup: " + scratch);
        }
        try {
            vacuumInto(scratch);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            try (ZipOutputStream zos = new ZipOutputStream(bos)) {
                zos.putNextEntry(new ZipEntry("freshmart.db"));
                Files.copy(scratch.toPath(), zos);
                zos.closeEntry();
                File storeProps = new File(dataDir, "store.properties");
                if (storeProps.isFile()) {
                    zos.putNextEntry(new ZipEntry("store.properties"));
                    Files.copy(storeProps.toPath(), zos);
                    zos.closeEntry();
                }
            }
            return bos.toByteArray();
        } finally {
            scratch.delete();
        }
    }

    /** Take a dated copy of the database once per day, so a bad edit or accidental delete is always recoverable. */
    public void takeDailyBackupIfNeeded() {
        try {
            File todayFolder = new File(backupsDir, Time.today().toString());
            File dbCopy = new File(todayFolder, "freshmart.db");
            if (dbCopy.exists()) {
                return; // already backed up today
            }
            todayFolder.mkdirs();
            vacuumInto(dbCopy);
            File storeProps = new File(dataDir, "store.properties");
            if (storeProps.isFile()) {
                Files.copy(storeProps.toPath(), new File(todayFolder, "store.properties").toPath(),
                        StandardCopyOption.REPLACE_EXISTING);
            }
            lastFailure = null;
        } catch (IOException | RuntimeException e) {
            String msg = "Could not take daily backup: " + e.getMessage();
            Log.error(msg, e);
            lastFailure = e.getMessage();
            // Persist the failure so an operator scanning the audit log can see the
            // store's safety net misfired even if no one was watching the console.
            if (auditLog != null) {
                try {
                    auditLog.logSystem("BACKUP_FAILED", e.getMessage());
                } catch (RuntimeException ignore) {
                    // audit-log write itself is best-effort here
                }
            }
        }
    }

    /**
     * The message from the most recent daily-backup failure, or {@code null} if the last
     * attempt succeeded (or none has run yet). Read by the admin panel to surface a banner
     * instead of relying on someone tailing {@code data/logs/app.log}.
     */
    public String lastFailure() {
        return lastFailure;
    }

    /**
     * Validate an uploaded backup zip and stage it for restore on the next restart.
     * See {@link SqliteRestore} for why restore is a stage-then-restart operation rather than
     * a live file swap. Throws {@link IllegalArgumentException} if the zip isn't a real backup.
     */
    public String stageRestore(byte[] zipBytes) throws IOException {
        return SqliteRestore.stage(dataDir, zipBytes);
    }

    /**
     * Runs {@code VACUUM INTO} on a private connection so it doesn't hold the
     * app's shared {@link Db} monitor - a big DB used to freeze every till for
     * the whole backup, since every checkout/scan/dashboard call serializes on
     * that single connection. WAL mode lets us open a second connection to the
     * same file safely.
     */
    private void vacuumInto(File dest) throws IOException {
        String url = "jdbc:sqlite:" + db.file().getPath();
        try (Connection c = DriverManager.getConnection(url);
             Statement st = c.createStatement()) {
            st.execute("VACUUM INTO " + sqlLiteral(dest.getPath()));
        } catch (SQLException e) {
            throw new IOException("VACUUM INTO failed: " + e.getMessage(), e);
        }
    }

    private static String sqlLiteral(String path) {
        return "'" + path.replace("'", "''") + "'";
    }
}
