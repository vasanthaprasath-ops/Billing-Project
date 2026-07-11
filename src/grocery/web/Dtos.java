package grocery.web;

import java.util.List;

/**
 * Plain data-transfer objects defining the JSON shape exchanged with the web UI.
 * Kept as simple fields (no BigDecimal / LocalDateTime) so Gson maps them
 * directly without custom adapters. Money is sent as a double for transport;
 * the server always recomputes the authoritative totals with BigDecimal.
 */
public final class Dtos {

    private Dtos() {
    }

    public static class StoreDto {
        public String name;
        public String addressLine1;
        public String addressLine2;
        public String phone;
        public String email;
        public String gstin;
        public String currency;
    }

    public static class ItemDto {
        public String id;
        public String branchId;
        public String name;
        public String category;
        public String unit;
        public double price;
        public Double costPrice;    // boxed so a missing field means "leave alone" on update
        public double taxRatePercent;
        public double stock;
        public String barcode;
        public double reorderLevel;
    }

    /** Body for POST /api/items/{id}/adjust-stock: either delta (+/-) or an absolute newStock. */
    public static class StockAdjustDto {
        public String branchId;
        public Double delta;      // e.g. +50 for a delivery, -3 for damaged units
        public Double newStock;   // optional alternative - set absolute stock (delta computed server-side)
        public String reason;
    }

    public static class CheckoutLineDto {
        public String itemId;
        public double quantity;
    }

    public static class CheckoutRequestDto {
        /** Only honoured for ADMIN callers - everyone else always bills against their own branch. */
        public String branchId;
        public String customerName;
        public String customerPhone;
        public String paymentMode;
        public double discount;
        /** Cash / card tendered by the customer. Optional (zero = "not captured"). */
        public double amountPaid;
        /** Buyer's state code for GST place-of-supply. Empty defaults to the branch's own state
         *  (intra-state). When different from the branch's state, the bill splits as IGST. */
        public String placeOfSupplyStateCode;
        public List<CheckoutLineDto> lines;
    }

    public static class InvoiceLineDto {
        public String itemId;
        public String name;
        public String unit;
        public double price;
        public double taxRatePercent;
        public double quantity;
        public double amount;
        public double tax;
    }

    public static class InvoiceDto {
        public String invoiceNo;
        public String branchId;
        public String branchName;
        public String cashierUsername;
        public String dateTime;
        public String customerName;
        public String customerPhone;
        public String paymentMode;
        public List<InvoiceLineDto> lines;
        public double subTotal;
        public double discount;
        public double totalTax;
        public double cgst;
        public double sgst;
        /** GST charged as IGST when the sale is inter-state (place-of-supply state != branch state); else zero. */
        public double igst;
        public boolean interState;
        public String placeOfSupplyStateCode;
        public double netAmount;
        public double roundOff;
        public double grandTotal;
        public double amountPaid;
        public double changeDue;
        public int itemCount;
        public String pdfUrl;
        public String thermalPdfUrl;
    }

    public static class CategoryRevenueDto {
        public String category;
        public double amount;

        public CategoryRevenueDto(String category, double amount) {
            this.category = category;
            this.amount = amount;
        }
    }

    public static class BranchRevenueDto {
        public String branchId;
        public String branchName;
        public double amount;
        public int invoiceCount;

        public BranchRevenueDto(String branchId, String branchName, double amount, int invoiceCount) {
            this.branchId = branchId;
            this.branchName = branchName;
            this.amount = amount;
            this.invoiceCount = invoiceCount;
        }
    }

    public static class LowStockDto {
        public String id;
        public String branchId;
        public String name;
        public String unit;
        public double stock;
        public double reorderLevel;

        public LowStockDto(String id, String branchId, String name, String unit, double stock, double reorderLevel) {
            this.id = id;
            this.branchId = branchId;
            this.name = name;
            this.unit = unit;
            this.stock = stock;
            this.reorderLevel = reorderLevel;
        }
    }

    public static class RecentInvoiceDto {
        public String invoiceNo;
        public String dateTime;
        public String customerName;
        public double grandTotal;

        public RecentInvoiceDto(String invoiceNo, String dateTime, String customerName, double grandTotal) {
            this.invoiceNo = invoiceNo;
            this.dateTime = dateTime;
            this.customerName = customerName;
            this.grandTotal = grandTotal;
        }
    }

    public static class DashboardDto {
        public boolean allBranches;
        public String branchId;
        public String branchName;
        /** Inclusive reporting window echoed back (yyyy-MM-dd), or null for all-time. */
        public String periodFrom;
        public String periodTo;
        public double totalSales;
        public double refundTotal;
        public int refundCount;
        /** totalSales - refundTotal. What the store actually keeps. */
        public double netSales;
        /** Net sales for the equal-length period immediately before this one, so the UI
         *  can render a "vs last period" delta. Zero when no comparable previous window
         *  applies (e.g. reportPeriod="all"). */
        public double previousNetSales;
        public int invoiceCount;
        public int itemCount;
        public int lowStockCount;
        public double averageSale;
        public List<CategoryRevenueDto> categoryRevenue;
        public List<BranchRevenueDto> branchRevenue;
        public List<LowStockDto> lowStock;
        public List<RecentInvoiceDto> recentInvoices;
        /** Cash / Card / UPI breakdown across the period. */
        public List<PaymentBreakdownDto> paymentMix;
        /** Best sellers by revenue in the period - up to 5. */
        public List<TopItemDto> topItems;
        /** Revenue minus current cost-of-goods (only counts lines with a known cost). */
        public double profit;
        /** Cost of goods sold on the covered lines (matches the profit calculation). */
        public double cogs;
        /** Gross margin percent = profit / coveredRevenue * 100 (0 if no cost data). */
        public double grossMarginPercent;
        /** Revenue on lines that had a known cost basis - hint denominator for the UI. */
        public double profitCoverage;
        /** Net revenue in scope (sales - refunds) - so UI can show "profit covers X of Y". */
        public double profitCoverableRevenue;
        /** Top profit contributors by category (may be shorter/different from categoryRevenue). */
        public List<CategoryRevenueDto> categoryProfit;
    }

    public static class BranchDto {
        public String id;
        public String name;
        public String addressLine1;
        public String addressLine2;
        public String phone;
        public String gstin;
        /** GST state code (e.g. "TN", "KA") - drives IGST vs CGST/SGST at checkout. */
        public String stateCode;
        public boolean active;
        /** Only used when creating a branch: seed its catalogue from this existing branch's items. */
        public String cloneFromBranchId;
    }

    public static class UserDto {
        public String username;
        /** Only sent by the client on create, or to reset a password - never returned by the server. */
        public String password;
        public String fullName;
        public String role;
        public String branchId;
        public String branchName;
        public boolean active;
        public boolean mustChangePassword;
    }

    public static class LoginRequestDto {
        public String username;
        public String password;
    }

    public static class ChangePasswordDto {
        public String currentPassword;
        public String newPassword;
    }

    public static class SessionDto {
        public String username;
        public String fullName;
        public String role;
        public String branchId;
        public String branchName;
        /** The user's own branch address/phone/GSTIN. Null when the user isn't tied to a branch (e.g. multi-branch ADMIN). */
        public String branchAddressLine1;
        public String branchAddressLine2;
        public String branchPhone;
        public String branchGstin;
        public boolean mustChangePassword;
    }

    public static class RefundLineDto {
        public String itemId;
        public String name;
        public String unit;
        public double price;
        public double taxRatePercent;
        public double quantity;
        public double amount;
        public double tax;
    }

    public static class RefundDto {
        public String refundNo;
        public String originalInvoiceNo;
        public String branchId;
        public String branchName;
        public String cashierUsername;
        public String dateTime;
        public String reason;
        public List<RefundLineDto> lines;
        public double refundAmount;
        public double refundTax;
        public int itemCount;
    }

    /** Sent by the client to raise a refund against an invoice - server enforces branch scope. */
    public static class RefundRequestDto {
        public String originalInvoiceNo;
        public String reason;
        public List<RefundLineRequestDto> lines;
    }

    public static class RefundLineRequestDto {
        public String itemId;
        public double quantity;
    }

    /** Per-line detail the "Return" modal needs: original qty vs already-refunded qty. */
    public static class RefundableLineDto {
        public String itemId;
        public String name;
        public String unit;
        public double price;
        public double taxRatePercent;
        public double originalQuantity;
        public double alreadyRefunded;
        public double remaining;

        public RefundableLineDto(String itemId, String name, String unit, double price,
                                 double taxRatePercent, double originalQuantity, double alreadyRefunded) {
            this.itemId = itemId;
            this.name = name;
            this.unit = unit;
            this.price = price;
            this.taxRatePercent = taxRatePercent;
            this.originalQuantity = originalQuantity;
            this.alreadyRefunded = alreadyRefunded;
            this.remaining = Math.max(0, originalQuantity - alreadyRefunded);
        }
    }

    public static class InvoiceRefundableDto {
        public String invoiceNo;
        public String branchId;
        public String dateTime;
        public String customerName;
        public String paymentMode;
        public double grandTotal;
        public List<RefundableLineDto> lines;
        public boolean anyRefundable;
    }

    public static class ZReportDto {
        public String date;
        public String branchId;
        public String branchName;
        public boolean allBranches;
        public int invoiceCount;
        public String firstInvoiceNo;
        public String lastInvoiceNo;
        public double subTotal;
        public double discount;
        public double cgst;
        public double sgst;
        public double igst;
        public double roundOff;
        public double grandTotal;
        public double cashSales;
        public double cashInDrawer;      // cashSales + change kept - change given out - refunds paid in cash
        public double refundTotal;
        public int refundCount;
        public double netSales;          // grandTotal - refundTotal
        public List<PaymentBreakdownDto> byPayment;
        public List<TopItemDto> topItems;
    }

    public static class PaymentBreakdownDto {
        public String mode;
        public int count;
        public double amount;

        public PaymentBreakdownDto(String mode, int count, double amount) {
            this.mode = mode;
            this.count = count;
            this.amount = amount;
        }
    }

    public static class TopItemDto {
        public String name;
        public double quantity;
        public String unit;
        public double amount;

        public TopItemDto(String name, double quantity, String unit, double amount) {
            this.name = name;
            this.quantity = quantity;
            this.unit = unit;
            this.amount = amount;
        }
    }

    public static class AuditEntryDto {
        public String when;
        public String username;
        public String role;
        public String branchId;
        public String action;
        public String details;
    }
}
