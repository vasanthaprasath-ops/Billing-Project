package grocery.auth;

import java.io.IOException;
import java.util.List;

import com.sun.net.httpserver.Filter;
import com.sun.net.httpserver.HttpExchange;

import grocery.model.User;
import grocery.service.UserService;
import grocery.web.Http;

/**
 * Requires a valid session for every {@code /api/*} request except signing
 * in and the public store-info endpoint (needed to brand the login screen
 * itself, before anyone has signed in).
 *
 * On success, attaches the resolved {@link User} to the exchange as
 * attribute {@code "user"} so {@code ApiHandler} can read it without looking
 * the session up again.
 */
public class AuthFilter extends Filter {

    private static final List<String> PUBLIC_GET = List.of("/store");
    private static final List<String> PUBLIC_POST = List.of("/auth/login");

    private final SessionManager sessions;
    private final UserService users;

    public AuthFilter(SessionManager sessions, UserService users) {
        this.sessions = sessions;
        this.users = users;
    }

    @Override
    public void doFilter(HttpExchange exchange, Filter.Chain chain) throws IOException {
        String sub = exchange.getRequestURI().getPath().substring("/api".length());
        String method = exchange.getRequestMethod();
        boolean isPublic = ("GET".equals(method) && PUBLIC_GET.contains(sub))
                || ("POST".equals(method) && PUBLIC_POST.contains(sub));
        if (isPublic) {
            chain.doFilter(exchange);
            return;
        }

        Session session = sessions.resolve(Http.readCookie(exchange, "sid"));
        User user = session == null ? null : users.findByUsername(session.username);
        if (session == null || user == null || !user.isActive()) {
            Http.sendError(exchange, 401, "Not signed in.");
            return;
        }
        exchange.setAttribute("user", user);
        chain.doFilter(exchange);
    }

    @Override
    public String description() {
        return "Session authentication for the JSON API";
    }
}
