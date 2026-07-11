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

        // CSRF defense: every state-changing request must come from our own origin. The Host
        // header (what the client dialled) is our authoritative "our own origin"; if the
        // request carries an Origin or Referer, it must match. Rejecting missing headers as
        // well would break curl/legit tools, so we only reject *mismatched* ones - Same-Site
        // cookies do the heavy lifting for the browser case. Login is checked too because
        // login itself is a state change (creates a session).
        if (isStateChanging(method) && !sameOrigin(exchange)) {
            Http.sendError(exchange, 403, "Cross-origin request blocked.");
            return;
        }

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

    private static boolean isStateChanging(String method) {
        return "POST".equals(method) || "PUT".equals(method) || "DELETE".equals(method) || "PATCH".equals(method);
    }

    /**
     * True if the request has no Origin/Referer, or the ones it has match this server's host.
     * We accept "missing" so command-line tools and same-origin fetch() calls (which sometimes
     * omit Origin) still work; we reject only *actual* cross-origin values, which is what a
     * malicious cross-site form or XHR would send.
     */
    private static boolean sameOrigin(HttpExchange ex) {
        String host = firstHeader(ex, "Host");
        if (host == null || host.isEmpty()) {
            return true;
        }
        String origin = firstHeader(ex, "Origin");
        String referer = firstHeader(ex, "Referer");
        return hostMatches(origin, host) && hostMatches(referer, host);
    }

    private static boolean hostMatches(String url, String host) {
        if (url == null || url.isEmpty() || "null".equals(url)) {
            return true; // header absent (or explicitly 'null') - let it through
        }
        // Extract the authority (host[:port]) from a full URL. Rough on purpose - we're not
        // parsing user input, just comparing what the browser reports as the caller's origin.
        int scheme = url.indexOf("://");
        if (scheme < 0) return false;
        String rest = url.substring(scheme + 3);
        int slash = rest.indexOf('/');
        String authority = slash < 0 ? rest : rest.substring(0, slash);
        return authority.equalsIgnoreCase(host);
    }

    private static String firstHeader(HttpExchange ex, String name) {
        List<String> v = ex.getRequestHeaders().get(name);
        return (v == null || v.isEmpty()) ? null : v.get(0);
    }
}
