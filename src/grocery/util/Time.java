package grocery.util;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * All wall-clock reads for the app funnel through here so a single config knob
 * (store.properties {@code timezone}) can pin every invoice timestamp, dashboard
 * period window, Z-report boundary and daily-backup rollover to the shop's
 * local time - regardless of whether the JVM was launched under UTC (e.g. a
 * Docker image), IST, or something else.
 *
 * <p>Defaults to Asia/Kolkata to match the app's Indian-market POS assumptions
 * (₹, en-IN, CGST/SGST split). Override with {@link #setZone} at startup.
 */
public final class Time {

    private static volatile ZoneId zone = ZoneId.of("Asia/Kolkata");

    private Time() {
    }

    public static ZoneId zone() {
        return zone;
    }

    public static void setZone(ZoneId z) {
        if (z != null) {
            zone = z;
        }
    }

    public static LocalDateTime now() {
        return LocalDateTime.now(zone);
    }

    public static LocalDate today() {
        return LocalDate.now(zone);
    }
}
