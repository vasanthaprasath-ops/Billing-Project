package grocery.auth;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * In-memory sliding-window brute-force guard for {@code /api/auth/login}.
 * <p>
 * Records one entry per failed attempt keyed by lower-cased username; once the
 * count of failures inside {@link #WINDOW} reaches {@link #MAX_ATTEMPTS} the
 * account is locked out for {@link #LOCKOUT} from the newest failure. A
 * successful login clears the record.
 * <p>
 * Deliberately username-only (not IP-scoped): the server runs on a LAN with a
 * small handful of well-known accounts, and pinning to IPs would let a single
 * mistyped password shift a shared tablet's whole till out of use.
 */
public final class LoginRateLimiter {

    static final int MAX_ATTEMPTS = 5;
    static final Duration WINDOW = Duration.ofMinutes(15);
    static final Duration LOCKOUT = Duration.ofMinutes(15);

    private final Map<String, Deque<Instant>> failures = new HashMap<>();

    /** Time until the account can try again, or {@link Duration#ZERO} if not locked. */
    public synchronized Duration lockoutRemaining(String username) {
        Deque<Instant> hits = pruneAndGet(username, Instant.now());
        if (hits == null || hits.size() < MAX_ATTEMPTS) {
            return Duration.ZERO;
        }
        Instant unlock = hits.peekLast().plus(LOCKOUT);
        Duration left = Duration.between(Instant.now(), unlock);
        return left.isNegative() ? Duration.ZERO : left;
    }

    public synchronized void recordFailure(String username) {
        String key = key(username);
        if (key == null) {
            return;
        }
        Deque<Instant> hits = failures.computeIfAbsent(key, k -> new ArrayDeque<>());
        prune(hits, Instant.now());
        hits.addLast(Instant.now());
    }

    public synchronized void recordSuccess(String username) {
        String key = key(username);
        if (key != null) {
            failures.remove(key);
        }
    }

    private Deque<Instant> pruneAndGet(String username, Instant now) {
        String key = key(username);
        if (key == null) {
            return null;
        }
        Deque<Instant> hits = failures.get(key);
        if (hits == null) {
            return null;
        }
        prune(hits, now);
        if (hits.isEmpty()) {
            failures.remove(key);
            return null;
        }
        return hits;
    }

    private void prune(Deque<Instant> hits, Instant now) {
        Instant cutoff = now.minus(WINDOW);
        for (Iterator<Instant> it = hits.iterator(); it.hasNext(); ) {
            if (it.next().isBefore(cutoff)) {
                it.remove();
            } else {
                break; // entries are appended in order
            }
        }
    }

    private String key(String username) {
        if (username == null) {
            return null;
        }
        String t = username.trim().toLowerCase(java.util.Locale.ROOT);
        return t.isEmpty() ? null : t;
    }
}
