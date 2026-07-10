package grocery.pdf;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.time.format.DateTimeFormatter;
import java.util.List;

import grocery.config.StoreConfig;
import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.util.Money;

/**
 * Lays out an {@link Invoice} as a narrow thermal-printer receipt (80mm roll)
 * instead of a full A4 tax invoice - what a supermarket till actually hands
 * the customer at the counter. A single page sized to fit the content
 * exactly, the same way a real receipt printer just keeps feeding paper.
 *
 * {@link #layout} is the single source of truth for the page layout: it is
 * run once with {@code d == null} to measure the exact height needed, then
 * again against a {@link PdfDocument} of that height to actually draw - so
 * the two can never drift out of sync with each other.
 */
public class ThermalReceiptPdfGenerator {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("dd MMM yyyy, hh:mm a");

    private static final float PAGE_WIDTH = 226f; // ~80mm thermal roll
    private static final float M = 10;             // page margin
    private static final float RIGHT = PAGE_WIDTH - M;
    private static final float LH = 11f;            // body line height
    private static final float BOTTOM_PADDING = 8f;

    private final StoreConfig store;

    public ThermalReceiptPdfGenerator(StoreConfig store) {
        this.store = store;
    }

    public File generate(Invoice invoice, File invoicesDir) throws IOException {
        invoicesDir.mkdirs();
        File out = new File(invoicesDir, invoice.getInvoiceNo() + "-thermal.pdf");

        float contentHeight = layout(null, invoice);
        PdfDocument d = new PdfDocument(PAGE_WIDTH, contentHeight + BOTTOM_PADDING);
        layout(d, invoice);

        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(d.toBytes());
        }
        return out;
    }

    /** Draws the receipt into {@code d} if it is non-null; always returns the total height used. */
    private float layout(PdfDocument d, Invoice inv) {
        float y = M;

        tc(d, y, 11, true, store.getName());
        y += 13;
        tc(d, y, 7.5f, false, store.getAddressLine1());
        y += 9;
        tc(d, y, 7.5f, false, store.getAddressLine2());
        y += 9;
        tc(d, y, 7.5f, false, "Ph: " + store.getPhone());
        y += 9;
        tc(d, y, 7.5f, false, "GSTIN: " + store.getGstin());
        y += 10;
        hr(d, y);
        y += 13;

        tc(d, y, 9.5f, true, "TAX INVOICE");
        y += 14;
        labelValue(d, y, 8, false, "Invoice No", inv.getInvoiceNo());
        y += LH;
        labelValue(d, y, 8, false, "Date", inv.getDateTime().format(DATE_FMT));
        y += LH;
        if (inv.getCashierUsername() != null && !inv.getCashierUsername().isEmpty()) {
            labelValue(d, y, 8, false, "Cashier", inv.getCashierUsername());
            y += LH;
        }
        labelValue(d, y, 8, false, "Customer", inv.getCustomerName());
        y += LH;
        if (inv.getCustomerPhone() != null && !inv.getCustomerPhone().isEmpty()) {
            labelValue(d, y, 8, false, "Phone", inv.getCustomerPhone());
            y += LH;
        }
        y += 2;
        hr(d, y);
        y += 12;

        List<InvoiceLine> lines = inv.getLines();
        for (InvoiceLine line : lines) {
            t(d, M, y, 8.5f, true, clip(line.getName(), 34));
            y += LH;
            String left = qty(line.getQuantity()) + " " + line.getUnit() + " x " + Money.format(line.getPrice());
            labelValue(d, y, 8, false, left, Money.format(line.getAmount()));
            y += LH;
        }
        y += 1;
        hr(d, y);
        y += 13;

        String cur = store.getCurrency() + " ";
        labelValue(d, y, 8.5f, false, "Sub Total", cur + Money.format(inv.getSubTotal()));
        y += LH;
        if (inv.getDiscount().compareTo(Money.ZERO) > 0) {
            labelValue(d, y, 8.5f, false, "Discount", "-" + cur + Money.format(inv.getDiscount()));
            y += LH;
        }
        if (inv.getTotalTax().compareTo(Money.ZERO) > 0) {
            labelValue(d, y, 8.5f, false, "CGST", cur + Money.format(inv.getCgst()));
            y += LH;
            labelValue(d, y, 8.5f, false, "SGST", cur + Money.format(inv.getSgst()));
            y += LH;
        }
        if (inv.getRoundOff().compareTo(Money.ZERO) != 0) {
            String sign = inv.getRoundOff().signum() > 0 ? "+" : "-";
            labelValue(d, y, 8.5f, false, "Round Off", sign + cur + Money.format(inv.getRoundOff().abs()));
            y += LH;
        }
        y += 4;
        hr(d, y);
        y += 16;
        labelValue(d, y, 12f, true, "GRAND TOTAL", cur + Money.format(inv.getGrandTotal()));
        y += 15;
        hr(d, y);
        y += 13;

        labelValue(d, y, 8, false, "Payment Mode", inv.getPaymentMode());
        y += LH;
        // Cash-tendered / change block: shown only when the customer actually gave more
        // than the total (a cash sale with change). Card / UPI / exact-cash rows stay clean.
        if (inv.getChangeDue().compareTo(Money.ZERO) > 0) {
            labelValue(d, y, 8, false, "Cash Tendered", cur + Money.format(inv.getAmountPaid()));
            y += LH;
            labelValue(d, y, 8.5f, true, "Change", cur + Money.format(inv.getChangeDue()));
            y += LH;
        }
        y += 7;
        tc(d, y, 9.5f, true, "Thank you for shopping with us!");
        y += 12;
        tc(d, y, 7.5f, false, store.getPhone() + "   " + store.getEmail());
        y += 10;
        y += M;

        return y;
    }

    // ---------------- null-safe drawing helpers (top-based coordinates) ----------------

    private void t(PdfDocument d, float x, float yTop, float size, boolean bold, String s) {
        if (d == null) {
            return;
        }
        d.text(x, d.height() - yTop, size, bold, s, 0, 0, 0);
    }

    private void tr(PdfDocument d, float xRight, float yTop, float size, boolean bold, String s) {
        if (d == null) {
            return;
        }
        float w = d.textWidth(s, size, bold);
        d.text(xRight - w, d.height() - yTop, size, bold, s, 0, 0, 0);
    }

    private void tc(PdfDocument d, float yTop, float size, boolean bold, String s) {
        if (d == null) {
            return;
        }
        float w = d.textWidth(s, size, bold);
        d.text((PAGE_WIDTH - w) / 2, d.height() - yTop, size, bold, s, 0, 0, 0);
    }

    private void hr(PdfDocument d, float yTop) {
        if (d == null) {
            return;
        }
        d.line(M, d.height() - yTop, PAGE_WIDTH - M, d.height() - yTop, 0.6f, 0, 0, 0);
    }

    private void labelValue(PdfDocument d, float yTop, float size, boolean bold, String label, String value) {
        t(d, M, yTop, size, bold, label);
        tr(d, RIGHT, yTop, size, bold, value);
    }

    // ---------------- formatting helpers ----------------

    private String qty(double q) {
        if (q == Math.floor(q)) {
            return String.valueOf((long) q);
        }
        return String.valueOf(q);
    }

    private String clip(String s, int max) {
        if (s.length() <= max) {
            return s;
        }
        return s.substring(0, max - 3) + "...";
    }
}
