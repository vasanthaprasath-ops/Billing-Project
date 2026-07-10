package grocery.web;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

/** Serves the static web front-end (HTML/CSS/JS) from the {@code web/} folder. */
public class StaticHandler implements HttpHandler {

    private final File root;

    public StaticHandler(File root) {
        this.root = root;
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (!ex.getRequestMethod().equals("GET")) {
            Http.sendError(ex, 405, "Method not allowed");
            return;
        }
        String path = ex.getRequestURI().getPath();
        if (path.equals("/") || path.isEmpty()) {
            path = "/index.html";
        }

        File file = new File(root, path).getCanonicalFile();
        // Guard against path traversal outside the web root.
        if (!file.getPath().startsWith(root.getCanonicalFile().getPath())
                || !file.exists() || file.isDirectory()) {
            Http.sendError(ex, 404, "Not found: " + path);
            return;
        }

        byte[] bytes = Files.readAllBytes(file.toPath());
        Http.sendBytes(ex, 200, contentType(file.getName()), bytes);
    }

    private String contentType(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) {
            return "text/html; charset=utf-8";
        }
        if (n.endsWith(".css")) {
            return "text/css; charset=utf-8";
        }
        if (n.endsWith(".js")) {
            return "application/javascript; charset=utf-8";
        }
        if (n.endsWith(".json")) {
            return "application/json; charset=utf-8";
        }
        if (n.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (n.endsWith(".png")) {
            return "image/png";
        }
        if (n.endsWith(".ico")) {
            return "image/x-icon";
        }
        return "application/octet-stream";
    }
}
