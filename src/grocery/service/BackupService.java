package grocery.service;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import grocery.util.Db;

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

    public BackupService(Db db, File dataDir) {
        this.db = db;
        this.dataDir = dataDir;
        this.backupsDir = new File(dataDir, "backups");
    }

    /** A fresh zip of {@code freshmart.db} + {@code store.properties} for on-demand download. */
    public byte[] zipData() throws IOException {
        File scratch = File.createTempFile("freshmart-backup-", ".db");
        if (!scratch.delete()) {
            throw new IOException("Could not prepare scratch path for backup: " + scratch);
        }
        try {
            db.exec("VACUUM INTO " + sqlLiteral(scratch.getPath()));
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
            File todayFolder = new File(backupsDir, LocalDate.now().toString());
            File dbCopy = new File(todayFolder, "freshmart.db");
            if (dbCopy.exists()) {
                return; // already backed up today
            }
            todayFolder.mkdirs();
            db.exec("VACUUM INTO " + sqlLiteral(dbCopy.getPath()));
            File storeProps = new File(dataDir, "store.properties");
            if (storeProps.isFile()) {
                Files.copy(storeProps.toPath(), new File(todayFolder, "store.properties").toPath(),
                        StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException | RuntimeException e) {
            System.err.println("Could not take daily backup: " + e.getMessage());
        }
    }

    private static String sqlLiteral(String path) {
        return "'" + path.replace("'", "''") + "'";
    }
}
