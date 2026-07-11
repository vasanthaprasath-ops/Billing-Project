package grocery.model;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import grocery.util.Money;

/**
 * A completed bill. Carries the customer details, the billed lines and the
 * computed totals. Once created it is immutable apart from being persisted.
 */
public class Invoice {

    private final String invoiceNo;
    private final String branchId;
    private final String cashierUsername;
    private final LocalDateTime dateTime;
    private final String customerName;
    private final String customerPhone;
    private final String paymentMode;
    private final List<InvoiceLine> lines;
    private final BigDecimal subTotal;
    private final BigDecimal discount;
    private final BigDecimal totalTax;
    private final BigDecimal netAmount;   // sub - discount + tax, before rounding
    private final BigDecimal roundOff;    // adjustment to reach the nearest rupee
    private final BigDecimal grandTotal;  // final payable, rounded to the nearest rupee
    private final BigDecimal amountPaid;  // cash/card tendered - >= grandTotal (change = paid - grand)
    /** Buyer's state code for GST place-of-supply. When set and different from the branch's
     *  own state, the invoice is treated as inter-state and the tax splits as IGST instead
     *  of CGST/SGST. Empty/null means "same state as the branch" (intra-state, the historical default). */
    private final String placeOfSupplyStateCode;
    /** True iff placeOfSupplyStateCode is set AND differs from branchStateCode. Cached because
     *  the branch is not part of this object and the caller (mapper / PDF) shouldn't have to
     *  compute this each time. */
    private final boolean interState;

    public Invoice(String invoiceNo, String branchId, String cashierUsername, LocalDateTime dateTime,
                   String customerName, String customerPhone, String paymentMode,
                   List<InvoiceLine> lines, BigDecimal discount) {
        this(invoiceNo, branchId, cashierUsername, dateTime, customerName, customerPhone, paymentMode,
                lines, discount, null, "", "");
    }

    public Invoice(String invoiceNo, String branchId, String cashierUsername, LocalDateTime dateTime,
                   String customerName, String customerPhone, String paymentMode,
                   List<InvoiceLine> lines, BigDecimal discount, BigDecimal amountPaid) {
        this(invoiceNo, branchId, cashierUsername, dateTime, customerName, customerPhone, paymentMode,
                lines, discount, amountPaid, "", "");
    }

    public Invoice(String invoiceNo, String branchId, String cashierUsername, LocalDateTime dateTime,
                   String customerName, String customerPhone, String paymentMode,
                   List<InvoiceLine> lines, BigDecimal discount, BigDecimal amountPaid,
                   String placeOfSupplyStateCode, String branchStateCode) {
        this.invoiceNo = invoiceNo;
        this.branchId = branchId;
        this.cashierUsername = cashierUsername;
        this.dateTime = dateTime;
        this.customerName = customerName;
        this.customerPhone = customerPhone;
        this.paymentMode = paymentMode;
        this.lines = new ArrayList<>(lines);
        this.placeOfSupplyStateCode = placeOfSupplyStateCode == null ? "" : placeOfSupplyStateCode;
        String bs = branchStateCode == null ? "" : branchStateCode;
        this.interState = !this.placeOfSupplyStateCode.isEmpty() && !bs.isEmpty()
                && !this.placeOfSupplyStateCode.equalsIgnoreCase(bs);

        BigDecimal sub = Money.ZERO;
        BigDecimal tax = Money.ZERO;
        for (InvoiceLine line : this.lines) {
            sub = sub.add(line.getAmount());
            tax = tax.add(line.getTax());
        }
        this.subTotal = Money.scale(sub);
        this.totalTax = Money.scale(tax);
        this.discount = Money.scale(discount);

        // Net payable before rounding, then rounded to the nearest rupee:
        // < 50 paise rounds down, >= 50 paise rounds up (HALF_UP).
        BigDecimal net = subTotal.subtract(this.discount).add(totalTax);
        this.netAmount = Money.scale(net);
        BigDecimal rounded = net.setScale(0, RoundingMode.HALF_UP);
        this.grandTotal = Money.scale(rounded);
        this.roundOff = Money.scale(this.grandTotal.subtract(this.netAmount));
        // A caller that did not track cash tendered (older calls / non-cash rows) is treated
        // as paid exactly - the change field then reads as zero on the receipt.
        this.amountPaid = Money.scale(amountPaid == null || amountPaid.compareTo(this.grandTotal) < 0
                ? this.grandTotal : amountPaid);
    }

    public String getInvoiceNo() {
        return invoiceNo;
    }

    public String getBranchId() {
        return branchId;
    }

    public String getCashierUsername() {
        return cashierUsername;
    }

    public LocalDateTime getDateTime() {
        return dateTime;
    }

    public String getCustomerName() {
        return customerName;
    }

    public String getCustomerPhone() {
        return customerPhone;
    }

    public String getPaymentMode() {
        return paymentMode;
    }

    public List<InvoiceLine> getLines() {
        return lines;
    }

    public BigDecimal getSubTotal() {
        return subTotal;
    }

    public BigDecimal getDiscount() {
        return discount;
    }

    public BigDecimal getTotalTax() {
        return totalTax;
    }

    /** Half of the GST, shown as CGST on the invoice (intra-state sale). Zero for inter-state. */
    public BigDecimal getCgst() {
        if (interState) {
            return Money.ZERO;
        }
        return Money.scale(totalTax.divide(BigDecimal.valueOf(2)));
    }

    /** The remaining half of the GST, shown as SGST (keeps the rounding exact). Zero for inter-state. */
    public BigDecimal getSgst() {
        if (interState) {
            return Money.ZERO;
        }
        return Money.scale(totalTax.subtract(getCgst()));
    }

    /** Full GST as IGST when the sale is inter-state (place-of-supply state differs from branch state); else zero. */
    public BigDecimal getIgst() {
        return interState ? Money.scale(totalTax) : Money.ZERO;
    }

    public boolean isInterState() {
        return interState;
    }

    public String getPlaceOfSupplyStateCode() {
        return placeOfSupplyStateCode;
    }

    /** Net payable before the rounding adjustment. */
    public BigDecimal getNetAmount() {
        return netAmount;
    }

    /** Rounding adjustment (signed): positive when rounded up, negative when down. */
    public BigDecimal getRoundOff() {
        return roundOff;
    }

    public BigDecimal getGrandTotal() {
        return grandTotal;
    }

    /** Cash / card tendered by the customer (always >= grandTotal). */
    public BigDecimal getAmountPaid() {
        return amountPaid;
    }

    /** Change to hand back = amountPaid - grandTotal (0 for exact payment, card or UPI). */
    public BigDecimal getChangeDue() {
        return Money.scale(amountPaid.subtract(grandTotal));
    }

    public int getTotalQuantityRoundedItems() {
        return lines.size();
    }
}
