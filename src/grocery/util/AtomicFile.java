package grocery.util;

import java.io.File;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/**
 * Crash-safe file writes: callers write the new contents to a sibling temp
 * file, then {@link #commit} atomically renames it over the target. Readers
 * (including another process, e.g. a shopkeeper opening the CSV in Excel)
 * therefore only ever see the fully-old or fully-new file, never a partial
 * write from a save that was interrupted mid-way.
 */
public final class AtomicFile {

    private AtomicFile() {
    }

    /** A fresh temp-file path next to {@code target}, creating the parent directory if needed. */
    public static File tempFor(File target) {
        File parent = target.getParentFile();
        if (parent != null) {
            parent.mkdirs();
        }
        return new File(parent, target.getName() + "." + System.nanoTime() + ".tmp");
    }

    private static final int MAX_ATTEMPTS = 3;

    /**
     * Atomically move {@code tmp} into {@code target}'s place, replacing any existing file.
     *
     * On Windows, a rename over a file that another process has open (an antivirus scanner,
     * Excel, a backup tool briefly indexing {@code items.csv}) can fail with a plain
     * {@code FileSystemException} rather than {@code AtomicMoveNotSupportedException}. Such
     * locks are almost always momentary, so this retries a couple of times with a short
     * backoff before giving up - the alternative is silently losing the write.
     */
    public static void commit(File tmp, File target) throws IOException {
        for (int attempt = 1; ; attempt++) {
            try {
                Files.move(tmp.toPath(), target.toPath(),
                        StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                return;
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
                return;
            } catch (IOException e) {
                if (attempt >= MAX_ATTEMPTS) {
                    throw e;
                }
                try {
                    Thread.sleep(50L * attempt);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw e;
                }
            }
        }
    }
}
