package grocery.auth;

import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.spec.InvalidKeySpecException;
import java.util.Base64;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Password hashing (PBKDF2WithHmacSHA256, salted, 600k iterations) and random
 * token generation, using only the JDK's built-in {@code javax.crypto} - no
 * extra dependency needed.
 *
 * <p>Stored form: {@code iterations:base64(salt):base64(hash)}. The iteration
 * count is embedded in every hash, so existing accounts continue to verify
 * against their original cost and only new hashes (created here) use the
 * higher target - matching OWASP's 2023 minimum without invalidating anyone.
 */
public final class PasswordHasher {

    private static final int ITERATIONS = 600_000;
    private static final int KEY_LENGTH_BITS = 256;
    private static final byte[] DECOY_SALT = new byte[16];
    private static final SecureRandom RNG = new SecureRandom();

    private PasswordHasher() {
    }

    public static String hash(String password) {
        byte[] salt = new byte[16];
        RNG.nextBytes(salt);
        byte[] hash = pbkdf2(password, salt, ITERATIONS);
        return ITERATIONS + ":" + b64(salt) + ":" + b64(hash);
    }

    public static boolean verify(String password, String stored) {
        if (stored == null) {
            return false;
        }
        try {
            String[] parts = stored.split(":");
            if (parts.length != 3) {
                return false;
            }
            int iterations = Integer.parseInt(parts[0]);
            byte[] salt = Base64.getDecoder().decode(parts[1]);
            byte[] expected = Base64.getDecoder().decode(parts[2]);
            byte[] actual = pbkdf2(password, salt, iterations);
            return constantTimeEquals(actual, expected);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Runs PBKDF2 with the current cost and discards the result - used by
     * {@code UserService.authenticate} on an unknown user so /api/auth/login's
     * response time doesn't shrink to milliseconds and hand an attacker a
     * side-channel to enumerate valid usernames.
     */
    public static void warmUp(String password) {
        if (password == null) {
            return;
        }
        pbkdf2(password, DECOY_SALT, ITERATIONS);
    }

    /** A random, easy-to-type password for first-run bootstrap (unambiguous characters only). */
    public static String randomPassword() {
        String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            sb.append(alphabet.charAt(RNG.nextInt(alphabet.length())));
        }
        return sb.toString();
    }

    /** A random URL-safe session token. */
    public static String randomToken() {
        byte[] b = new byte[32];
        RNG.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static byte[] pbkdf2(String password, byte[] salt, int iterations) {
        try {
            PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, KEY_LENGTH_BITS);
            SecretKeyFactory skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            return skf.generateSecret(spec).getEncoded();
        } catch (NoSuchAlgorithmException | InvalidKeySpecException e) {
            throw new IllegalStateException("Password hashing unavailable: " + e.getMessage(), e);
        }
    }

    private static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a.length != b.length) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < a.length; i++) {
            diff |= a[i] ^ b[i];
        }
        return diff == 0;
    }

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }
}
