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

    public static void setCookie(HttpExchange ex, String name, String value, int maxAgeSeconds) {
        ex.getResponseHeaders().add("Set-Cookie",
                name + "=" + value + "; HttpOnly; Path=/; Max-Age=" + maxAgeSeconds + "; SameSite=Lax");
    }

    public static void sendJson(HttpExchange ex, int status, Object body) throws IOException {
        byte[] bytes = Json.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        send(ex, status, bytes);
    }

    public static void sendError(HttpExchange ex, int status, String message) throws IOException {
        Map<String, String> body = new HashMap<>();
        body.put("error", message);
        sendJson(ex, status, body);
    }

    public static void sendBytes(HttpExchange ex, int status, String contentType, byte[] bytes) throws IOException {
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
