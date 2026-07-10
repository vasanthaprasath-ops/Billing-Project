package grocery;

import grocery.auth.LoginRateLimiter;
import grocery.auth.SessionManager;
import grocery.config.StoreConfig;
import grocery.pdf.InvoicePdfGenerator;
import grocery.pdf.ThermalReceiptPdfGenerator;
import grocery.service.AuditLogService;
import grocery.service.BackupService;
import grocery.service.BillingService;
import grocery.service.BranchService;
import grocery.service.InventoryService;
import grocery.service.InvoiceStore;
import grocery.service.RefundService;
import grocery.service.UserService;

/**
 * Simple holder that wires together the services so the UI panels can share
 * a single inventory, invoice store and billing session.
 */
public class AppContext {

    private final StoreConfig store;
    private final BranchService branches;
    private final InventoryService inventory;
    private final InvoiceStore invoiceStore;
    private final RefundService refunds;
    private final UserService users;
    private final AuditLogService auditLog;
    private final SessionManager sessions;
    private final LoginRateLimiter loginRateLimiter;
    private final BackupService backup;
    private final BillingService billing;
    private final InvoicePdfGenerator pdfGenerator;
    private final ThermalReceiptPdfGenerator thermalPdfGenerator;

    public AppContext(StoreConfig store, BranchService branches, InventoryService inventory,
                      InvoiceStore invoiceStore, RefundService refunds, UserService users,
                      AuditLogService auditLog, SessionManager sessions, LoginRateLimiter loginRateLimiter,
                      BackupService backup, BillingService billing,
                      InvoicePdfGenerator pdfGenerator, ThermalReceiptPdfGenerator thermalPdfGenerator) {
        this.store = store;
        this.branches = branches;
        this.inventory = inventory;
        this.invoiceStore = invoiceStore;
        this.refunds = refunds;
        this.users = users;
        this.auditLog = auditLog;
        this.sessions = sessions;
        this.loginRateLimiter = loginRateLimiter;
        this.backup = backup;
        this.billing = billing;
        this.pdfGenerator = pdfGenerator;
        this.thermalPdfGenerator = thermalPdfGenerator;
    }

    public StoreConfig store() {
        return store;
    }

    public BranchService branches() {
        return branches;
    }

    public InventoryService inventory() {
        return inventory;
    }

    public InvoiceStore invoiceStore() {
        return invoiceStore;
    }

    public RefundService refunds() {
        return refunds;
    }

    public UserService users() {
        return users;
    }

    public AuditLogService auditLog() {
        return auditLog;
    }

    public SessionManager sessions() {
        return sessions;
    }

    public LoginRateLimiter loginRateLimiter() {
        return loginRateLimiter;
    }

    public BackupService backup() {
        return backup;
    }

    public BillingService billing() {
        return billing;
    }

    public InvoicePdfGenerator pdfGenerator() {
        return pdfGenerator;
    }

    public ThermalReceiptPdfGenerator thermalPdfGenerator() {
        return thermalPdfGenerator;
    }
}
