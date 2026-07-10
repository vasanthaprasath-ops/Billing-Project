package grocery.util;

import java.io.File;
import java.io.IOException;
import java.util.logging.FileHandler;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.logging.SimpleFormatter;

/**
 * Tiny wrapper around {@code java.util.logging} - just enough structure to
 * replace the {@code System.err.println} / {@code printStackTrace} calls that
 * used to leave no forensic trail once a {@code nohup java …} console scrolled
 * off. Rotates through 10 x 10&nbsp;MB files under {@code data/logs/}, and
 * still echoes to the console so operators watching a live terminal see the
 * same output they always did.
 */
public final class Log {

    private static final Logger LOGGER = Logger.getLogger("grocery");
    private static boolean initialized;

    private Log() {
    }

    /** Wire a rotating file handler under {@code logDir}. Safe to call twice - only the first call does anything. */
    public static synchronized void init(File logDir) {
        if (initialized) {
            return;
        }
        try {
            if (!logDir.isDirectory() && !logDir.mkdirs()) {
                LOGGER.warning("Could not create log directory " + logDir + " - file logging disabled");
                initialized = true;
                return;
            }
            String pattern = new File(logDir, "app-%g.log").getPath();
            FileHandler fh = new FileHandler(pattern, 10 * 1024 * 1024, 10, true);
            fh.setFormatter(new SimpleFormatter());
            LOGGER.addHandler(fh);
        } catch (IOException e) {
            LOGGER.log(Level.WARNING, "Could not attach file log handler; console-only logging", e);
        }
        initialized = true;
    }

    public static void info(String msg) {
        LOGGER.info(msg);
    }

    public static void warn(String msg) {
        LOGGER.warning(msg);
    }

    public static void warn(String msg, Throwable t) {
        LOGGER.log(Level.WARNING, msg, t);
    }

    public static void error(String msg) {
        LOGGER.severe(msg);
    }

    public static void error(String msg, Throwable t) {
        LOGGER.log(Level.SEVERE, msg, t);
    }
}
