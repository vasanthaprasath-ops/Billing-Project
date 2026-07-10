package grocery.web;

import java.time.format.DateTimeFormatter;

import grocery.config.StoreConfig;
import grocery.model.AuditEntry;
import grocery.model.Branch;
import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.model.Item;
import grocery.model.Refund;
import grocery.model.User;
import grocery.service.BranchService;

/** Converts domain model objects into the JSON-friendly DTOs. */
public final class Mappers {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm");
    private static final DateTimeFormatter AUDIT_DATE_FMT = DateTimeFormatter.ofPattern("dd-MM-yyyy HH:mm:ss");

    private Mappers() {
    }

    public static Dtos.StoreDto store(StoreConfig s) {
        Dtos.StoreDto d = new Dtos.StoreDto();
        d.name = s.getName();
        d.addressLine1 = s.getAddressLine1();
        d.addressLine2 = s.getAddressLine2();
        d.phone = s.getPhone();
        d.email = s.getEmail();
        d.gstin = s.getGstin();
        d.currency = s.getCurrency();
        return d;
    }

    public static Dtos.ItemDto item(Item it) {
        Dtos.ItemDto d = new Dtos.ItemDto();
        d.id = it.getId();
        d.branchId = it.getBranchId();
        d.name = it.getName();
        d.category = it.getCategory();
        d.unit = it.getUnit();
        d.price = it.getPrice().doubleValue();
        d.taxRatePercent = it.getTaxRatePercent();
        d.stock = it.getStock();
        d.barcode = it.getBarcode();
        d.reorderLevel = it.getReorderLevel();
        return d;
    }

    public static Dtos.BranchDto branch(Branch b) {
        Dtos.BranchDto d = new Dtos.BranchDto();
        d.id = b.getId();
        d.name = b.getName();
        d.addressLine1 = b.getAddressLine1();
        d.addressLine2 = b.getAddressLine2();
        d.phone = b.getPhone();
        d.gstin = b.getGstin();
        d.active = b.isActive();
        return d;
    }

    public static Dtos.UserDto user(User u, BranchService branches) {
        Dtos.UserDto d = new Dtos.UserDto();
        d.username = u.getUsername();
        d.fullName = u.getFullName();
        d.role = u.getRole().name();
        d.branchId = u.getBranchId();
        d.branchName = branchName(u.getBranchId(), branches);
        d.active = u.isActive();
        d.mustChangePassword = u.isMustChangePassword();
        return d;
    }

    public static Dtos.SessionDto session(User u, BranchService branches) {
        Dtos.SessionDto d = new Dtos.SessionDto();
        d.username = u.getUsername();
        d.fullName = u.getFullName();
        d.role = u.getRole().name();
        d.branchId = u.getBranchId();
        d.branchName = branchName(u.getBranchId(), branches);
        if (u.getBranchId() != null) {
            Branch b = branches.findById(u.getBranchId());
            if (b != null) {
                d.branchAddressLine1 = b.getAddressLine1();
                d.branchAddressLine2 = b.getAddressLine2();
                d.branchPhone = b.getPhone();
                d.branchGstin = b.getGstin();
            }
        }
        d.mustChangePassword = u.isMustChangePassword();
        return d;
    }

    public static Dtos.AuditEntryDto auditEntry(AuditEntry e) {
        Dtos.AuditEntryDto d = new Dtos.AuditEntryDto();
        d.when = e.getWhen().format(AUDIT_DATE_FMT);
        d.username = e.getUsername();
        d.role = e.getRole() == null ? "" : e.getRole().name();
        d.branchId = e.getBranchId();
        d.action = e.getAction();
        d.details = e.getDetails();
        return d;
    }

    public static Dtos.InvoiceDto invoice(Invoice inv, BranchService branches) {
        Dtos.InvoiceDto d = new Dtos.InvoiceDto();
        d.invoiceNo = inv.getInvoiceNo();
        d.branchId = inv.getBranchId();
        d.branchName = branchName(inv.getBranchId(), branches);
        d.cashierUsername = inv.getCashierUsername();
        d.dateTime = inv.getDateTime().format(DATE_FMT);
        d.customerName = inv.getCustomerName();
        d.customerPhone = inv.getCustomerPhone();
        d.paymentMode = inv.getPaymentMode();
        d.subTotal = inv.getSubTotal().doubleValue();
        d.discount = inv.getDiscount().doubleValue();
        d.totalTax = inv.getTotalTax().doubleValue();
        d.cgst = inv.getCgst().doubleValue();
        d.sgst = inv.getSgst().doubleValue();
        d.netAmount = inv.getNetAmount().doubleValue();
        d.roundOff = inv.getRoundOff().doubleValue();
        d.grandTotal = inv.getGrandTotal().doubleValue();
        d.amountPaid = inv.getAmountPaid().doubleValue();
        d.changeDue = inv.getChangeDue().doubleValue();
        d.itemCount = inv.getLines().size();
        d.pdfUrl = "/api/invoices/" + inv.getInvoiceNo() + "/pdf";
        d.thermalPdfUrl = "/api/invoices/" + inv.getInvoiceNo() + "/pdf?format=thermal";
        d.lines = new java.util.ArrayList<>();
        for (InvoiceLine line : inv.getLines()) {
            d.lines.add(invoiceLine(line));
        }
        return d;
    }

    public static Dtos.RefundDto refund(Refund r, BranchService branches) {
        Dtos.RefundDto d = new Dtos.RefundDto();
        d.refundNo = r.getRefundNo();
        d.originalInvoiceNo = r.getOriginalInvoiceNo();
        d.branchId = r.getBranchId();
        d.branchName = branchName(r.getBranchId(), branches);
        d.cashierUsername = r.getCashierUsername();
        d.dateTime = r.getDateTime().format(DATE_FMT);
        d.reason = r.getReason();
        d.refundAmount = r.getRefundAmount().doubleValue();
        d.refundTax = r.getRefundTax().doubleValue();
        d.itemCount = r.getLines().size();
        d.lines = new java.util.ArrayList<>();
        for (InvoiceLine line : r.getLines()) {
            Dtos.RefundLineDto rl = new Dtos.RefundLineDto();
            rl.itemId = line.getItemId();
            rl.name = line.getName();
            rl.unit = line.getUnit();
            rl.price = line.getPrice().doubleValue();
            rl.taxRatePercent = line.getTaxRatePercent();
            rl.quantity = line.getQuantity();
            rl.amount = line.getAmount().doubleValue();
            rl.tax = line.getTax().doubleValue();
            d.lines.add(rl);
        }
        return d;
    }

    public static Dtos.InvoiceLineDto invoiceLine(InvoiceLine line) {
        Dtos.InvoiceLineDto d = new Dtos.InvoiceLineDto();
        d.itemId = line.getItemId();
        d.name = line.getName();
        d.unit = line.getUnit();
        d.price = line.getPrice().doubleValue();
        d.taxRatePercent = line.getTaxRatePercent();
        d.quantity = line.getQuantity();
        d.amount = line.getAmount().doubleValue();
        d.tax = line.getTax().doubleValue();
        return d;
    }

    private static String branchName(String branchId, BranchService branches) {
        if (branchId == null) {
            return "All Branches";
        }
        Branch b = branches.findById(branchId);
        return b == null ? branchId : b.getName();
    }
}
