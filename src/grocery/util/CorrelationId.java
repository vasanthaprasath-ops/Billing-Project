package grocery.util;

import java.security.SecureRandom;

/**
 * A short, opaque token attached to every 500-error response so an operator can
 * grep the server log for the matching stack trace without the raw exception
 * ever reaching the client. Not a security boundary - just a request-tagging
 * convenience.
 */
public final class CorrelationId {

    private static final SecureRandom RNG = new SecureRandom();
    private static final String ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

    private CorrelationId() {
    }

    public static String next() {
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) {
            sb.append(ALPHABET.charAt(RNG.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }
}
