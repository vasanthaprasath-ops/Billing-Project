package grocery.util;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Small helper for working with money values.
 * All amounts are kept as {@link BigDecimal} scaled to 2 decimal places
 * so that billing totals are exact (never use raw doubles for money).
 */
public final class Money {

    public static final BigDecimal ZERO = BigDecimal.ZERO.setScale(2, RoundingMode.HALF_UP);

    private Money() {
    }

    /** Build a money value from a double, rounded to 2 decimals. */
    public static BigDecimal of(double value) {
        return BigDecimal.valueOf(value).setScale(2, RoundingMode.HALF_UP);
    }

    /** Parse a money value from text, returns ZERO on blank/invalid input. */
    public static BigDecimal parse(String text) {
        if (text == null) {
            return ZERO;
        }
        String cleaned = text.trim().replace(",", "");
        if (cleaned.isEmpty()) {
            return ZERO;
        }
        try {
            return new BigDecimal(cleaned).setScale(2, RoundingMode.HALF_UP);
        } catch (NumberFormatException e) {
            return ZERO;
        }
    }

    /** Round any BigDecimal to the canonical 2-decimal money scale. */
    public static BigDecimal scale(BigDecimal value) {
        return value.setScale(2, RoundingMode.HALF_UP);
    }

    /** Format as a plain string with exactly 2 decimals, e.g. "1234.50". */
    public static String format(BigDecimal value) {
        return scale(value).toPlainString();
    }
}
