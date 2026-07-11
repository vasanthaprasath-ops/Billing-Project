package grocery.web;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.sun.net.httpserver.HttpExchange;

/** Small helpers for reading requests and writing responses on an {@link HttpExchange}. */
public final class Http {

    private Http() {
    }

    public static String readBody(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /**
     * Reads the raw request body (for binary uploads like a restore .zip), refusing anything
     * larger than {@code maxBytes} so a hostile or accidental huge upload can't exhaust memory.
     */
    public static byte[] readBodyBytes(HttpExchange ex, int maxBytes) throws IOException {
        try (InputStream in = ex.getRequestBody()) {
            byte[] data = in.readNBytes(maxBytes + 1);
            if (data.length > maxBytes) {
                throw new IllegalArgumentException("Upload too large (maximum " + (maxBytes / (1024 * 1024)) + " MB).");
            }
            return data;
        }
    }

    public static Map<String, String> queryParams(HttpExchange ex) {
        Map<String, String> params = new HashMap<>();
        String raw = ex.getRequestURI().getRawQuery();
        if (raw == null || raw.isEmpty()) {
            return params;
        }
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq >= 0) {
                String k = decode(pair.substring(0, eq));
                String v = decode(pair.substring(eq + 1));
                params.put(k, v);
            } else {
                params.put(decode(pair), "");
            }
        }
        return params;
    }

    private static String decode(String s) {
        return URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    public static String readCookie(HttpExchange ex, String name) {
        List<String> headers = ex.getRequestHeaders().get("Cookie");
        if (headers == null) {
            return null;
        }
        for (String header : headers) {
            for (String part : header.split(";")) {
                String p = part.trim();
                if (p.startsWith(name + "=")) {
                    return p.substring(name.length() + 1);
                }
            }
        }
        return null;
    }

    /** True when {@code -DSESSION_SECURE=true} (or the env var of the same name) was set at boot -
     *  flip it on when the app sits behind an HTTPS reverse proxy so the cookie never rides plain HTTP. */
    private static final boolean SECURE_COOKIES = Boolean.parseBoolean(
            System.getProperty("SESSION_SECURE", System.getenv().getOrDefault("SESSION_SECURE", "false")));

    public static void setCookie(HttpExchange ex, String name, String value, int maxAgeSeconds) {
        String secure = SECURE_COOKIES ? "; Secure" : "";
        ex.getResponseHeaders().add("Set-Cookie",
                name + "=" + value + "; HttpOnly; Path=/; Max-Age=" + maxAgeSeconds + "; SameSite=Lax" + secure);
    }

    /**
     * The client's IP as best we can tell it. Honours {@code X-Forwarded-For} first so a
     * reverse-proxy deployment doesn't collapse every real client to the proxy's IP,
     * then falls back to the direct socket address.
     */
    public static String remoteIp(HttpExchange ex) {
        List<String> xff = ex.getRequestHeaders().get("X-Forwarded-For");
        if (xff != null && !xff.isEmpty()) {
            String first = xff.get(0);
            if (first != null && !first.isEmpty()) {
                int comma = first.indexOf(',');
                return (comma < 0 ? first : first.substring(0, comma)).trim();
            }
        }
        return ex.getRemoteAddress() == null ? "" : ex.getRemoteAddress().getAddress().getHostAddress();
    }

    /**
     * Standard defense-in-depth headers on every response - light on features, heavy on the
     * common footguns. {@code nosniff} kills content-type sniffing shenanigans; {@code DENY}
     * on framing blocks clickjacking; a strict same-origin CSP means an XSS'd chunk of markup
     * can't call out to an attacker's domain; {@code no-referrer} keeps invoice URLs from
     * leaking to any external site the user clicks off to. HSTS is set only when we're
     * genuinely on HTTPS ({@code SESSION_SECURE=true}); on plain http:// it would just be
     * ignored, or worse cache a promise we can't keep.
     */
    public static void applySecurityHeaders(HttpExchange ex) {
        var h = ex.getResponseHeaders();
        h.set("X-Content-Type-Options", "nosniff");
        h.set("X-Frame-Options", "DENY");
        h.set("Referrer-Policy", "no-referrer");
        // Same-origin only; inline scripts/styles are used by index.html but no eval, no remote hosts.
        h.set("Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                + "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        if (SECURE_COOKIES) {
            h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        }
    }

    public static void sendJson(HttpExchange ex, int status, Object body) throws IOException {
        byte[] bytes = Json.toJson(body).getBytes(StandardCharsets.UTF_8);
        applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        send(ex, status, bytes);
    }

    public static void sendError(HttpExchange ex, int status, String message) throws IOException {
        Map<String, String> body = new HashMap<>();
        body.put("error", message);
        sendJson(ex, status, body);
    }

    public static void sendBytes(HttpExchange ex, int status, String contentType, byte[] bytes) throws IOException {
        applySecurityHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", contentType);
        send(ex, status, bytes);
    }

    private static void send(HttpExchange ex, int status, byte[] bytes) throws IOException {
        ex.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            try (OutputStream out = ex.getResponseBody()) {
                out.write(bytes);
            }
        } else {
            ex.close();
        }
    }
}
