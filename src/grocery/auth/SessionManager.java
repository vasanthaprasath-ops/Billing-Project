package grocery.auth;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Keeps signed-in sessions in memory (this is a single-process server; there
 * is nothing else to share them with). Sessions expire automatically after
 * {@link #TTL_HOURS} of being issued.
 */
public final class SessionManager {

    private static final long TTL_HOURS = 12;

    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();

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
