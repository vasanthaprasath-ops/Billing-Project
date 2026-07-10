package grocery.auth;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keeps signed-in sessions in memory (this is a single-process server; there
 * is nothing else to share them with). Sessions expire automatically after
 * {@link #TTL_HOURS} of being issued.
 *
 * <p>A daemon sweeper prunes expired entries every 5 minutes; without it the
 * map only shrank when someone happened to reuse an expired token (rare in
 * practice - closed browser tabs never come back), so it leaked one entry per
 * sign-in on a 24/7 POS.
 */
public final class SessionManager {

    private static final long TTL_HOURS = 12;
    private static final long SWEEP_INTERVAL_MS = 5 * 60 * 1000L;

    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();

    public SessionManager() {
        Thread sweeper = new Thread(this::sweepLoop, "session-sweeper");
        sweeper.setDaemon(true);
        sweeper.start();
    }

    private void sweepLoop() {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Thread.sleep(SWEEP_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            sessions.values().removeIf(Session::isExpired);
        }
    }

    public Session create(String username) {
        String token = PasswordHasher.randomToken();
        Session session = new Session(token, username, Instant.now().plus(TTL_HOURS, ChronoUnit.HOURS));
        sessions.put(token, session);
        return session;
    }

    /** Look up a session by token, returning {@code null} if missing or expired. */
    public Session resolve(String token) {
        if (token == null) {
            return null;
        }
        Session session = sessions.get(token);
        if (session == null) {
            return null;
        }
        if (session.isExpired()) {
            sessions.remove(token);
            return null;
        }
        return session;
    }

    public void invalidate(String token) {
        if (token != null) {
            sessions.remove(token);
        }
    }

    /** Drop every session belonging to a user, e.g. after their password changes. */
    public void invalidateAllFor(String username) {
        sessions.values().removeIf(s -> s.username.equalsIgnoreCase(username));
    }
}
