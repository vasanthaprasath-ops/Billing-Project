package grocery.model;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import grocery.util.Money;

/**
 * A refund raised against a previously-issued invoice. Immutable once created;
 * lines are a snapshot of what came back over the counter (so a later price
 * change on the item does not rewrite history). Uses {@link InvoiceLine} for
 * line-item shape because the fields are identical - a returned line carries
 * the same item id, unit, quantity, amount and tax as the original sale line.
 * <p>
 * Discount is deliberately NOT refunded per line: a bill-wide discount was a
 * one-time gesture, and pro-rating it across returned items would make daily
 * reconciliation less predictable than customers and cashiers expect.
 */
public class Refund {

    private final String refundNo;
    private final String originalInvoiceNo;
    private final String branchId;
    private final String cashierUsername;
    private final LocalDateTime dateTime;
    private final List<InvoiceLine> lines;
    private final String reason;
    private final BigDecimal refundAmount;   // sum of line (amount + tax) - what the till pays out
    private final BigDecimal refundTax;      // sum of line tax alone - for the GST return

    public Refund(String refundNo, String originalInvoiceNo, String branchId, String cashierUsername,
                  LocalDateTime dateTime, List<InvoiceLine> lines, String reason) {
        this.refundNo = refundNo;
        this.originalInvoiceNo = originalInvoiceNo;
        this.branchId = branchId;
        this.cashierUsername = cashierUsername;
        this.dateTime = dateTime;
        this.lines = new ArrayList<>(lines);
        this.reason = reason == null ? "" : reason;

        BigDecimal amt = Money.ZERO;
        BigDecimal tax = Money.ZERO;
        for (InvoiceLine line : this.lines) {
            amt = amt.add(line.getAmount()).add(line.getTax());
            tax = tax.add(line.getTax());
        }
        this.refundAmount = Money.scale(amt);
        this.refundTax = Money.scale(tax);
    }

    public String getRefundNo() { return refundNo; }
    public String getOriginalInvoiceNo() { return originalInvoiceNo; }
    public String getBranchId() { return branchId; }
    public String getCashierUsername() { return cashierUsername; }
    public LocalDateTime getDateTime() { return dateTime; }
    public List<InvoiceLine> getLines() { return lines; }
    public String getReason() { return reason; }
    public BigDecimal getRefundAmount() { return refundAmount; }
    public BigDecimal getRefundTax() { return refundTax; }
}
