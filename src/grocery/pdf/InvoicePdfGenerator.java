package grocery.pdf;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.format.DateTimeFormatter;
import java.util.List;

import grocery.config.StoreConfig;
import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.util.Money;

/**
 * Lays out an {@link Invoice} as a modern, colourful A4 tax-invoice PDF using
 * {@link PdfDocument}: a branded header band, a striped item table, a totals
 * box with the grand total highlighted, the amount in words, and a warm
 * personalised greeting + thank-you footer. Multi-page bills repeat the table
 * header automatically.
 */
public class InvoicePdfGenerator {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("dd MMM yyyy, hh:mm a");

    // palette (RGB 0..1)
    private static final float[] GREEN = {0.086f, 0.639f, 0.290f};
    private static final float[] GREEN_DARK = {0.078f, 0.325f, 0.176f};
    private static final float[] LIGHT_GREEN = {0.886f, 0.969f, 0.910f};
    private static final float[] WHITE = {1f, 1f, 1f};
    private static final float[] WHITE_SOFT = {0.85f, 0.95f, 0.88f};
    private static final float[] DARK = {0.06f, 0.09f, 0.16f};
    private static final float[] MUTED = {0.39f, 0.45f, 0.54f};
    private static final float[] ZEBRA = {0.965f, 0.973f, 0.969f};
    private static final float[] LINE = {0.85f, 0.87f, 0.86f};

    private static final float M = 40;        // page margin
    private static final float ROW_H = 19;    // table row height

    // column anchors
    private static final float COL_NO = 48;
    private static final float COL_ITEM = 72;
    private static final float COL_QTY_R = 332;
    private static final float COL_UNIT = 344;
    private static final float COL_RATE_R = 432;
    private static final float COL_GST_R = 486;
    private static final float COL_AMT_R = 551;

    private final StoreConfig store;

    public InvoicePdfGenerator(StoreConfig store) {
        this.store = store;
    }

    public File generate(Invoice invoice, File invoicesDir) throws IOException {
        invoicesDir.mkdirs();
        File out = new File(invoicesDir, invoice.getInvoiceNo() + ".pdf");

        PdfDocument d = new PdfDocument();
        drawHeaderBand(d, invoice);
        float y = drawParties(d, invoice);
        y = drawTableHeader(d, y);

        List<InvoiceLine> lines = invoice.getLines();
        for (int i = 0; i < lines.size(); i++) {
            if (y + ROW_H > d.height() - 250) {  // keep room for totals + footer
                d.newPage();
                y = drawContinuationHeader(d, invoice);
                y = drawTableHeader(d, y);
            }
            drawRow(d, y, i + 1, lines.get(i), i % 2 == 1);
            y += ROW_H;
        }

        hline(d, M, d.width() - M, y, 0.8f, LINE);
        y += 18;
        drawTotals(d, y, invoice);
        drawGreetingFooter(d, invoice);

        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(d.toBytes());
        }
        return out;
    }

    // ---------------- sections ----------------

    private void drawHeaderBand(PdfDocument d, Invoice inv) {
        float right = d.width() - M;
        rect(d, 0, 0, d.width(), 104, GREEN);

        t(d, M, 40, 22, true, store.getName(), WHITE);
        t(d, M, 58, 9, false, store.getAddressLine1(), WHITE_SOFT);
        t(d, M, 70, 9, false, store.getAddressLine2(), WHITE_SOFT);
        t(d, M, 82, 8.5f, false, "Ph: " + store.getPhone() + "    " + store.getEmail(), WHITE_SOFT);
        t(d, M, 94, 8.5f, false, "GSTIN: " + store.getGstin(), WHITE_SOFT);

        tr(d, right, 44, 26, true, "INVOICE", WHITE);
        tr(d, right, 64, 11, true, "No: " + inv.getInvoiceNo(), WHITE);
        tr(d, right, 79, 9.5f, false, inv.getDateTime().format(DATE_FMT), WHITE_SOFT);
    }

    private float drawContinuationHeader(PdfDocument d, Invoice inv) {
        float right = d.width() - M;
        rect(d, 0, 0, d.width(), 42, GREEN);
        t(d, M, 27, 15, true, store.getName(), WHITE);
        tr(d, right, 27, 12, true, "Invoice " + inv.getInvoiceNo() + " (contd.)", WHITE);
        return 64;
    }

    private float drawParties(PdfDocument d, Invoice inv) {
        float right = d.width() - M;
        float y = 132;

        t(d, M, y, 9, true, "BILL TO", MUTED);
        tr(d, right, y, 9, true, "PAYMENT MODE", MUTED);
        y += 16;
        t(d, M, y, 12.5f, true, inv.getCustomerName(), DARK);
        tr(d, right, y, 12.5f, true, inv.getPaymentMode(), GREEN_DARK);
        y += 14;
        if (inv.getCustomerPhone() != null && !inv.getCustomerPhone().isEmpty()) {
            t(d, M, y, 9.5f, false, "Phone: " + inv.getCustomerPhone(), MUTED);
        }
        y += 10;

        hline(d, M, right, y, 0.6f, LINE);
        y += 22;

        // warm, personalised greeting
        t(d, M, y, 11, true, "Dear " + inv.getCustomerName() + ",", DARK);
        y += 15;
        t(d, M, y, 9.5f, false,
                "Thank you for shopping with us! Here is a summary of your purchase.", MUTED);
        y += 18;
        return y;
    }

    private float drawTableHeader(PdfDocument d, float yTop) {
        float right = d.width() - M;
        rect(d, M, yTop, right - M, 22, GREEN_DARK);
        float b = yTop + 15;
        t(d, COL_NO, b, 9, true, "#", WHITE);
        t(d, COL_ITEM, b, 9, true, "ITEM", WHITE);
        tr(d, COL_QTY_R, b, 9, true, "QTY", WHITE);
        t(d, COL_UNIT, b, 9, true, "UNIT", WHITE);
        tr(d, COL_RATE_R, b, 9, true, "RATE", WHITE);
        tr(d, COL_GST_R, b, 9, true, "GST%", WHITE);
        tr(d, COL_AMT_R, b, 9, true, "AMOUNT", WHITE);
        return yTop + 24;
    }

    private void drawRow(PdfDocument d, float yTop, int sno, InvoiceLine line, boolean zebra) {
        float right = d.width() - M;
        if (zebra) {
            rect(d, M, yTop, right - M, ROW_H, ZEBRA);
        }
        float b = yTop + 13;
        t(d, COL_NO, b, 9, false, String.valueOf(sno), DARK);
        t(d, COL_ITEM, b, 9, false, clip(line.getName(), 40), DARK);
        tr(d, COL_QTY_R, b, 9, false, qty(line.getQuantity()), DARK);
        t(d, COL_UNIT, b, 9, false, line.getUnit(), MUTED);
        tr(d, COL_RATE_R, b, 9, false, Money.format(line.getPrice()), DARK);
        tr(d, COL_GST_R, b, 9, false, trimPct(line.getTaxRatePercent()), MUTED);
        tr(d, COL_AMT_R, b, 9, false, Money.format(line.getAmount()), DARK);
    }

    private void drawTotals(PdfDocument d, float yTop, Invoice inv) {
        float right = d.width() - M;
        String cur = store.getCurrency() + " ";
        float labelX = 360;
        float y = yTop;

        totalLine(d, labelX, right, y, "Sub Total", cur + Money.format(inv.getSubTotal()));
        y += 16;
        if (inv.getDiscount().compareTo(Money.ZERO) > 0) {
            totalLine(d, labelX, right, y, "Discount", "- " + cur + Money.format(inv.getDiscount()));
            y += 16;
        }
        if (inv.getTotalTax().compareTo(Money.ZERO) > 0) {
            totalLine(d, labelX, right, y, "CGST", cur + Money.format(inv.getCgst()));
            y += 16;
            totalLine(d, labelX, right, y, "SGST", cur + Money.format(inv.getSgst()));
            y += 16;
        }
        if (inv.getRoundOff().compareTo(Money.ZERO) != 0) {
            String sign = inv.getRoundOff().signum() > 0 ? "+ " : "- ";
            totalLine(d, labelX, right, y, "Round Off", sign + cur + Money.format(inv.getRoundOff().abs()));
            y += 16;
        }

        // highlighted grand total bar
        y += 2;
        rect(d, labelX - 8, y, right - (labelX - 8), 26, GREEN);
        t(d, labelX, y + 17, 12, true, "GRAND TOTAL", WHITE);
        tr(d, right - 6, y + 17, 13, true, cur + Money.format(inv.getGrandTotal()), WHITE);
        y += 36;

        // amount in words (full width)
        t(d, M, y, 9, true, "Amount in words:", MUTED);
        y += 13;
        t(d, M, y, 9.5f, false, amountInWords(inv.getGrandTotal()), DARK);
        y += 16;

        if (inv.getDiscount().compareTo(Money.ZERO) > 0) {
            t(d, M, y, 9.5f, true,
                    "You saved " + cur + Money.format(inv.getDiscount()) + " on this purchase!", GREEN_DARK);
        }
    }

    private void totalLine(PdfDocument d, float labelX, float valueR, float yTop, String label, String value) {
        t(d, labelX, yTop + 11, 10, false, label, MUTED);
        tr(d, valueR - 6, yTop + 11, 10, false, value, DARK);
    }

    private void drawGreetingFooter(PdfDocument d, Invoice inv) {
        float H = d.height();
        tcenter(d, H - 96, 8, false,
                "This is a computer-generated invoice and does not require a signature.", MUTED);
        rect(d, 0, H - 80, d.width(), 80, LIGHT_GREEN);
        tcenter(d, H - 53, 13, true, "Thank you for shopping with us!", GREEN_DARK);
        tcenter(d, H - 37, 9.5f, false,
                "We truly appreciate your visit and hope to see you again soon.", MUTED);
        tcenter(d, H - 22, 8, false,
                store.getName() + "   |   " + store.getPhone() + "   |   " + store.getEmail(), MUTED);
    }

    // ---------------- drawing helpers (top-based coordinates) ----------------

    private void t(PdfDocument d, float x, float yTop, float size, boolean bold, String s, float[] c) {
        d.text(x, d.height() - yTop, size, bold, s, c[0], c[1], c[2]);
    }

    private void tr(PdfDocument d, float xRight, float yTop, float size, boolean bold, String s, float[] c) {
        float w = d.textWidth(s, size, bold);
        d.text(xRight - w, d.height() - yTop, size, bold, s, c[0], c[1], c[2]);
    }

    private void tcenter(PdfDocument d, float yTop, float size, boolean bold, String s, float[] c) {
        float w = d.textWidth(s, size, bold);
        d.text((d.width() - w) / 2, d.height() - yTop, size, bold, s, c[0], c[1], c[2]);
    }

    private void rect(PdfDocument d, float xLeft, float yTopEdge, float w, float h, float[] c) {
        d.fillRect(xLeft, d.height() - (yTopEdge + h), w, h, c[0], c[1], c[2]);
    }

    private void hline(PdfDocument d, float x1, float x2, float yTop, float width, float[] c) {
        d.line(x1, d.height() - yTop, x2, d.height() - yTop, width, c[0], c[1], c[2]);
    }

    // ---------------- formatting helpers ----------------

    private String qty(double q) {
        if (q == Math.floor(q)) {
            return String.valueOf((long) q);
        }
        return String.valueOf(q);
    }

    private String trimPct(double p) {
        if (p == Math.floor(p)) {
            return (long) p + "%";
        }
        return p + "%";
    }

    private String clip(String s, int max) {
        if (s.length() <= max) {
            return s;
        }
        return s.substring(0, max - 3) + "...";
    }

    // ---------------- amount in words (Indian numbering) ----------------

    private static final String[] ONES = {
            "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
            "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
            "Seventeen", "Eighteen", "Nineteen"};
    private static final String[] TENS = {
            "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"};

    private String amountInWords(BigDecimal amount) {
        long rupees = amount.longValue();
        int paise = amount.subtract(BigDecimal.valueOf(rupees))
                .multiply(BigDecimal.valueOf(100))
                .setScale(0, RoundingMode.HALF_UP).intValue();
        StringBuilder sb = new StringBuilder("Rupees ").append(words(rupees));
        if (paise > 0) {
            sb.append(" and ").append(words(paise)).append(" Paise");
        }
        return sb.append(" Only").toString();
    }

    private String words(long n) {
        if (n == 0) {
            return "Zero";
        }
        StringBuilder s = new StringBuilder();
        long crore = n / 10000000;
        n %= 10000000;
        long lakh = n / 100000;
        n %= 100000;
        long thousand = n / 1000;
        n %= 1000;
        long hundred = n / 100;
        n %= 100;
        if (crore > 0) {
            s.append(words(crore)).append(" Crore ");
        }
        if (lakh > 0) {
            s.append(twoDigits((int) lakh)).append(" Lakh ");
        }
        if (thousand > 0) {
            s.append(twoDigits((int) thousand)).append(" Thousand ");
        }
        if (hundred > 0) {
            s.append(ONES[(int) hundred]).append(" Hundred ");
        }
        if (n > 0) {
            s.append(twoDigits((int) n));
        }
        return s.toString().trim();
    }

    private String twoDigits(int n) {
        if (n < 20) {
            return ONES[n];
        }
        return TENS[n / 10] + (n % 10 != 0 ? " " + ONES[n % 10] : "");
    }
}
