package grocery;

import java.awt.Desktop;
import java.io.File;
import java.net.URI;
import java.sql.SQLException;
import java.util.Arrays;

import grocery.auth.LoginRateLimiter;
import grocery.auth.SessionManager;
import grocery.config.StoreConfig;
import grocery.model.Invoice;
import grocery.pdf.InvoicePdfGenerator;
import grocery.pdf.ThermalReceiptPdfGenerator;
import grocery.service.AuditLogService;
import grocery.service.BackupService;
import grocery.service.BillingService;
import grocery.service.BranchService;
import grocery.service.InventoryService;
import grocery.service.InvoiceStore;
import grocery.service.RefundService;
import grocery.service.SqliteMigration;
import grocery.service.UserService;
import grocery.util.Db;
import grocery.web.WebServer;

/**
 * Application entry point.
 *
 * Default: start the web server and open the store UI in the browser.
 * {@code --demo}: headless self-test (seeds data, rings up a sample bill,
 *                 writes sample invoice PDFs) - handy for CI / servers.
 *
 * Optional first argument when starting the server: the port (default 8080).
 */
public class Main {

    public static final File DATA_DIR = new File("data");
    public static final File INVOICES_DIR = new File("invoices");
    public static final File WEB_DIR = new File("web");
    public static final File STORE_FILE = new File(DATA_DIR, "store.properties");
    public static final File DB_FILE = new File(DATA_DIR, "freshmart.db");

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && ("--demo".equals(args[0]) || "--selftest".equals(args[0]))) {
            runDemo();
            return;
        }

        startServer(resolvePort(args));
    }

    /**
     * The port to serve on: an explicit numeric argument wins, then the {@code PORT}
     * environment variable (so port-assigning launchers work out of the box), then 8080.
     */
    private static int resolvePort(String[] args) {
        for (String a : args) {
            if (a.matches("\\d+")) {
                return Integer.parseInt(a);
            }
        }
        String env = System.getenv("PORT");
        if (env != null && env.matches("\\d+")) {
            return Integer.parseInt(env);
        }
        return 8080;
    }

    private static AppContext buildContext() {
        DATA_DIR.mkdirs();
        INVOICES_DIR.mkdirs();
        StoreConfig store = new StoreConfig(STORE_FILE);

        SqliteMigration.migrateIfNeeded(DATA_DIR, DB_FILE);
        Db db;
        try {
            db = Db.open(DB_FILE);
        } catch (SQLException e) {
            throw new RuntimeException("Could not open database: " + e.getMessage(), e);
        }
        // Lets Ctrl+C checkpoint WAL and release the file lock cleanly instead of relying on abrupt process death.
        Runtime.getRuntime().addShutdownHook(new Thread(db::close));

        BranchService branches = new BranchService(db, store);
        InventoryService inventory = new InventoryService(db, branches.defaultBranchId());
        InvoiceStore invoiceStore = new InvoiceStore(db);
        RefundService refunds = new RefundService(db);
        UserService users = new UserService(db);
        AuditLogService auditLog = new AuditLogService(db);
        SessionManager sessions = new SessionManager();
        LoginRateLimiter loginRateLimiter = new LoginRateLimiter();
        BackupService backup = new BackupService(db, DATA_DIR);
        BillingService billing = new BillingService();
        InvoicePdfGenerator pdf = new InvoicePdfGenerator(store);
        ThermalReceiptPdfGenerator thermalPdf = new ThermalReceiptPdfGenerator(store);

        backup.takeDailyBackupIfNeeded();
        String bootstrapPassword = users.consumeBootstrapPassword();
        if (bootstrapPassword != null) {
            printBootstrapCredentials(bootstrapPassword);
            auditLog.logSystem("BOOTSTRAP", "created initial admin account");
        }

        return new AppContext(store, branches, inventory, invoiceStore, refunds, users, auditLog,
                sessions, loginRateLimiter, backup, billing, pdf, thermalPdf);
    }

    private static void printBootstrapCredentials(String password) {
        System.out.println();
        System.out.println("  ============================================================");
        System.out.println("  First run - an administrator account has been created:");
        System.out.println();
        System.out.println("      Username: admin");
        System.out.println("      Password: " + password);
        System.out.println();
        System.out.println("  You will be asked to choose your own password on first sign-in.");
        System.out.println("  This password is shown only this once - write it down now.");
        System.out.println("  ============================================================");
        System.out.println();
    }

    private static void startServer(int port) throws Exception {
        AppContext ctx = buildContext();
        WebServer server = new WebServer(ctx, port, WEB_DIR, INVOICES_DIR);
        server.start();

        String url = "http://localhost:" + port + "/";
        System.out.println();
        System.out.println("  " + ctx.store().getName());
        System.out.println("  Grocery Store Billing System is running.");
        System.out.println("  Open in your browser:  " + url);
        System.out.println("  Press Ctrl+C to stop.");
        System.out.println();

        openBrowser(url);
    }

    private static void openBrowser(String url) {
        try {
            if (!Boolean.getBoolean("noBrowser")
                    && Desktop.isDesktopSupported()
                    && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(new URI(url));
            }
        } catch (Exception ignore) {
            // headless or no browser - the user can open the URL manually
        }
    }

    private static void runDemo() {
        System.out.println("=== Grocery Billing - headless self-test ===");
        AppContext ctx = buildContext();
        System.out.println("Branches: " + ctx.branches().getAll().size());
        System.out.println("Catalogue items: " + ctx.inventory().getAll(ctx.branches().defaultBranchId()).size());

        try {
            Invoice invoice = ctx.billing().checkout(
                    ctx.branches().defaultBranchId(), "admin",
                    "Ramesh Kumar", "+91 90000 11111", "UPI",
                    grocery.util.Money.of(20),
                    Arrays.asList(
                            new BillingService.LineRequest("ITM-001", 2),
                            new BillingService.LineRequest("ITM-007", 3),
                            new BillingService.LineRequest("ITM-019", 1.5),
                            new BillingService.LineRequest("ITM-011", 1)),
                    ctx.inventory(), ctx.invoiceStore());

            System.out.println("Sub total : " + invoice.getSubTotal());
            System.out.println("Total tax : " + invoice.getTotalTax());
            System.out.println("Grand tot : " + invoice.getGrandTotal());

            File pdf = ctx.pdfGenerator().generate(invoice, INVOICES_DIR);
            System.out.println("Invoice " + invoice.getInvoiceNo()
                    + " grand total " + invoice.getGrandTotal());
            System.out.println("A4 invoice PDF written: " + pdf.getAbsolutePath()
                    + " (" + pdf.length() + " bytes)");
            boolean ok = PdfSelfCheck.verify(pdf);
            System.out.println("A4 PDF structural check: " + (ok ? "PASS" : "FAIL"));

            File thermal = ctx.thermalPdfGenerator().generate(invoice, INVOICES_DIR);
            System.out.println("Thermal receipt PDF written: " + thermal.getAbsolutePath()
                    + " (" + thermal.length() + " bytes)");
            boolean thermalOk = PdfSelfCheck.verify(thermal);
            System.out.println("Thermal PDF structural check: " + (thermalOk ? "PASS" : "FAIL"));

            byte[] backupZip = ctx.backup().zipData();
            System.out.println("Backup zip size: " + backupZip.length + " bytes");
        } catch (Exception e) {
            System.out.println("Demo FAILED: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
