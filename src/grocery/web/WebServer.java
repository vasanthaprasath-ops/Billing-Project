package grocery.web;

import java.io.File;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpServer;

import grocery.AppContext;
import grocery.auth.AuthFilter;

/**
 * Wraps the JDK's built-in {@link HttpServer}. Serves the static web UI from
 * the {@code web/} folder and the JSON API under {@code /api}.
 */
public class WebServer {

    private final AppContext ctx;
    private final int port;
    private final File webRoot;
    private final File invoicesDir;
    private HttpServer server;

    public WebServer(AppContext ctx, int port, File webRoot, File invoicesDir) {
        this.ctx = ctx;
        this.port = port;
        this.webRoot = webRoot;
        this.invoicesDir = invoicesDir;
    }

    public void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(port), 0);
        // More specific context (/api) takes precedence over "/".
        HttpContext api = server.createContext("/api", new ApiHandler(ctx, invoicesDir));
        api.getFilters().add(new AuthFilter(ctx.sessions(), ctx.users()));
        server.createContext("/", new StaticHandler(webRoot));
        server.setExecutor(Executors.newFixedThreadPool(8));
        server.start();
    }

    public void stop() {
        if (server != null) {
            server.stop(0);
        }
    }
}
