package grocery.util;

/**
 * Input sanitisation for free-text fields that get persisted as a single CSV
 * column. {@link Csv#encode} correctly quotes a value that contains an
 * embedded newline, but every reader in this app reads physical lines with
 * {@code BufferedReader.readLine()} before the quote-aware parser ever sees
 * them, so a stored embedded newline would silently split one record into
 * two malformed rows on the next load. None of the fields that flow through
 * here (names, addresses, phone numbers, usernames) have any legitimate
 * reason to span multiple lines, so the simplest safe fix is to never let a
 * newline reach storage in the first place.
 */
public final class Text {

    private Text() {
    }

    /** Collapse any CR/LF in {@code s} to a single space and trim; never null. */
    public static String oneLine(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\r\n", " ").replace('\r', ' ').replace('\n', ' ').trim();
    }
}
