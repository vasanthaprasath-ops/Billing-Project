package grocery.auth;

import java.time.Instant;

/** A signed-in session, identified by an opaque bearer token carried in a cookie. */
public final class Session {

    public final String token;
    public final String username;
    public final Instant expiresAt;

    public Session(String token, String username, Instant expiresAt) {
        this.token = token;
        this.username = username;
        this.expiresAt = expiresAt;
    }

    public boolean isExpired() {
        return Instant.now().isAfter(expiresAt);
    }
}
