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

    // A single IP failing across many usernames still gets throttled - the per-user
    // limit alone let an attacker spray 5 attempts each against a dozen accounts
    // unchallenged. Set well above what a legit shared-tablet cashier would ever
    // hit in a shift so a normal wrong-password day doesn't lock the whole till.
    static final int IP_MAX_ATTEMPTS = 30;
    static final Duration IP_WINDOW = Duration.ofMinutes(15);
    static final Duration IP_LOCKOUT = Duration.ofMinutes(5);

    private final Map<String, Deque<Instant>> failures = new HashMap<>();
    private final Map<String, Deque<Instant>> ipFailures = new HashMap<>();

    /** Time until the account can try again, or {@link Duration#ZERO} if not locked. */
    public synchronized Duration lockoutRemaining(String username) {
        Deque<Instant> hits = pruneAndGet(failures, key(username), Instant.now(), WINDOW);
        if (hits == null || hits.size() < MAX_ATTEMPTS) {
            return Duration.ZERO;
        }
        Instant unlock = hits.peekLast().plus(LOCKOUT);
        Duration left = Duration.between(Instant.now(), unlock);
        return left.isNegative() ? Duration.ZERO : left;
    }

    /** Time until this IP can try again, or {@link Duration#ZERO}. */
    public synchronized Duration ipLockoutRemaining(String ip) {
        Deque<Instant> hits = pruneAndGet(ipFailures, ipKey(ip), Instant.now(), IP_WINDOW);
        if (hits == null || hits.size() < IP_MAX_ATTEMPTS) {
            return Duration.ZERO;
        }
        Instant unlock = hits.peekLast().plus(IP_LOCKOUT);
        Duration left = Duration.between(Instant.now(), unlock);
        return left.isNegative() ? Duration.ZERO : left;
    }

    public synchronized void recordFailure(String username, String ip) {
        record(failures, key(username), WINDOW);
        record(ipFailures, ipKey(ip), IP_WINDOW);
    }

    public synchronized void recordSuccess(String username) {
        String key = key(username);
        if (key != null) {
            failures.remove(key);
        }
    }

    private void record(Map<String, Deque<Instant>> store, String key, Duration window) {
        if (key == null) {
            return;
        }
        Deque<Instant> hits = store.computeIfAbsent(key, k -> new ArrayDeque<>());
        prune(hits, Instant.now(), window);
        hits.addLast(Instant.now());
    }

    private Deque<Instant> pruneAndGet(Map<String, Deque<Instant>> store, String key,
                                       Instant now, Duration window) {
        if (key == null) {
            return null;
        }
        Deque<Instant> hits = store.get(key);
        if (hits == null) {
            return null;
        }
        prune(hits, now, window);
        if (hits.isEmpty()) {
            store.remove(key);
            return null;
        }
        return hits;
    }

    private void prune(Deque<Instant> hits, Instant now, Duration window) {
        Instant cutoff = now.minus(window);
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

    private String ipKey(String ip) {
        if (ip == null) {
            return null;
        }
        String t = ip.trim();
        return t.isEmpty() ? null : t;
    }
}
