package grocery.util;

import java.util.ArrayList;
import java.util.List;

/**
 * Minimal RFC-4180 style CSV encoder/decoder so we can persist data
 * to plain files without any external library. Handles fields that
 * contain commas, quotes or newlines via double-quote escaping.
 */
public final class Csv {

    private Csv() {
    }

    /** Encode a row of fields into a single CSV line (no trailing newline). */
    public static String encode(String... fields) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < fields.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(encodeField(fields[i]));
        }
        return sb.toString();
    }

    private static String encodeField(String field) {
        String value = field == null ? "" : field;
        boolean mustQuote = value.contains(",") || value.contains("\"")
                || value.contains("\n") || value.contains("\r");
        if (!mustQuote) {
            return value;
        }
        return '"' + value.replace("\"", "\"\"") + '"';
    }

    /** Parse a single CSV line into its fields. */
    public static List<String> parse(String line) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                        cur.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    cur.append(c);
                }
            } else {
                if (c == '"') {
                    inQuotes = true;
                } else if (c == ',') {
                    out.add(cur.toString());
                    cur.setLength(0);
                } else {
                    cur.append(c);
                }
            }
        }
        out.add(cur.toString());
        return out;
    }
}
