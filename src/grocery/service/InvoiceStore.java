package grocery.service;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import grocery.util.Time;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.util.Csv;
import grocery.util.Db;
import grocery.util.Money;

/**
 * Persists completed invoices and hands out invoice numbers.
 * <p>
 * Two tables back this: {@code invoices} (one row per invoice - the header /
 * totals) and {@code invoice_lines} (one row per billed line, keyed by
 * invoice number). Together they let the History tab list past sales and
 * re-generate any PDF.
 */
public class InvoiceStore {

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    private final Db db;
    /** Used at load-time to reconstruct interState correctly for historical invoices (compare
     *  each invoice's placeOfSupplyStateCode against its branch's current stateCode). Nullable
     *  for the legacy no-branch constructor still used by tests. */
    private final BranchService branches;
    private final List<Invoice> invoices = new ArrayList<>();

    public InvoiceStore(Db db) {
        this(db, null);
    }

    public InvoiceStore(Db db, BranchService branches) {
        this.db = db;
        this.branches = branches;
        loadFromDb();
    }

    /** Every invoice, across every branch (head-office view) - newest first. */
    public synchronized List<Invoice> getAll() {
        List<Invoice> copy = new ArrayList<>(invoices);
        copy.sort((a, b) -> b.getDateTime().compareTo(a.getDateTime()));
        return copy;
    }

    /** Invoices for one branch only, newest first. */
    public synchronized List<Invoice> getAllForBranch(String branchId) {
        List<Invoice> out = new ArrayList<>();
        for (Invoice inv : invoices) {
            if (inv.getBranchId().equalsIgnoreCase(branchId)) {
                out.add(inv);
            }
        }
        out.sort((a, b) -> b.getDateTime().compareTo(a.getDateTime()));
        return out;
    }

    public synchronized Invoice findByNo(String invoiceNo) {
        for (Invoice inv : invoices) {
            if (inv.getInvoiceNo().equalsIgnoreCase(invoiceNo)) {
                return inv;
            }
        }
        return null;
    }

    /**
     * Allocate the next invoice number, build the invoice and persist it, all
     * as one atomic step - this is what stops two simultaneous checkouts from
     * both grabbing the same invoice number. The header and line-item rows
     * commit in a single transaction so a crash mid-write can never leave one
     * without the other.
     */
    public synchronized Invoice createAndSave(String branchId, String cashierUsername, String customerName,
                                              String customerPhone, String paymentMode,
                                              List<InvoiceLine> lines, BigDecimal discount,
                                              BigDecimal amountPaid) {
        return createAndSave(branchId, cashierUsername, customerName, customerPhone, paymentMode,
                lines, discount, amountPaid, "", "");
    }

    /**
     * Full-form createAndSave: additionally carries the {@code placeOfSupplyStateCode} (buyer's
     * state) and the branch's own {@code branchStateCode}, which together decide whether this
     * bill is inter-state (IGST) or intra-state (CGST+SGST). Callers that don't know GST
     * place-of-supply (headless demo, legacy CSV migration) use the shorter overload above and
     * the invoice defaults to intra-state (historical behaviour).
     */
    public synchronized Invoice createAndSave(String branchId, String cashierUsername, String customerName,
                                              String customerPhone, String paymentMode,
                                              List<InvoiceLine> lines, BigDecimal discount,
                                              BigDecimal amountPaid,
                                              String placeOfSupplyStateCode, String branchStateCode) {
        Invoice invoice = new Invoice(nextInvoiceNoLocked(), branchId, cashierUsername, Time.now(),
                customerName, customerPhone, paymentMode, lines, discount, amountPaid,
                placeOfSupplyStateCode, branchStateCode);
        db.inTransaction(() -> {
            insertHeader(invoice);
            for (InvoiceLine line : invoice.getLines()) {
                insertLine(invoice.getInvoiceNo(), line);
            }
        });
        invoices.add(invoice);
        return invoice;
    }

    private String nextInvoiceNoLocked() {
        int max = 1000;
        for (Invoice inv : invoices) {
            String no = inv.getInvoiceNo();
            int dash = no.lastIndexOf('-');
            if (dash >= 0) {
                try {
                    max = Math.max(max, Integer.parseInt(no.substring(dash + 1)));
                } catch (NumberFormatException ignore) {
                    // skip
                }
            }
        }
        return "INV-" + (max + 1);
    }

    // ---------------- persistence ----------------

    private void insertHeader(Invoice inv) {
        db.update("INSERT INTO invoices(invoiceNo, branchId, cashierUsername, dateTime, customerName, " +
                "customerPhone, paymentMode, subTotal, discount, totalTax, grandTotal, amountPaid, " +
                "placeOfSupplyStateCode) " +
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, inv.getInvoiceNo());
            ps.setString(2, inv.getBranchId());
            ps.setString(3, inv.getCashierUsername());
            ps.setString(4, inv.getDateTime().format(STAMP));
            ps.setString(5, inv.getCustomerName());
            ps.setString(6, inv.getCustomerPhone());
            ps.setString(7, inv.getPaymentMode());
            ps.setString(8, Money.format(inv.getSubTotal()));
            ps.setString(9, Money.format(inv.getDiscount()));
            ps.setString(10, Money.format(inv.getTotalTax()));
            ps.setString(11, Money.format(inv.getGrandTotal()));
            ps.setString(12, Money.format(inv.getAmountPaid()));
            ps.setString(13, inv.getPlaceOfSupplyStateCode() == null ? "" : inv.getPlaceOfSupplyStateCode());
        });
    }

    private void insertLine(String invoiceNo, InvoiceLine line) {
        db.update("INSERT INTO invoice_lines(invoiceNo, itemId, name, unit, price, taxRatePercent, " +
                "quantity, amount, tax) VALUES(?,?,?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, invoiceNo);
            ps.setString(2, line.getItemId());
            ps.setString(3, line.getName());
            ps.setString(4, line.getUnit());
            ps.setString(5, Money.format(line.getPrice()));
            ps.setDouble(6, line.getTaxRatePercent());
            ps.setDouble(7, line.getQuantity());
            ps.setString(8, Money.format(line.getAmount()));
            ps.setString(9, Money.format(line.getTax()));
        });
    }

    private void loadFromDb() {
        Map<String, List<InvoiceLine>> linesByInvoice = new HashMap<>();
        for (LineRow row : db.query("SELECT * FROM invoice_lines", InvoiceStore::mapLineRow)) {
            linesByInvoice.computeIfAbsent(row.invoiceNo, k -> new ArrayList<>()).add(row.line);
        }
        for (Invoice inv : db.query("SELECT * FROM invoices", rs -> mapHeaderRow(rs, linesByInvoice, branches))) {
            invoices.add(inv);
        }
    }

    private static final class LineRow {
        final String invoiceNo;
        final InvoiceLine line;

        LineRow(String invoiceNo, InvoiceLine line) {
            this.invoiceNo = invoiceNo;
            this.line = line;
        }
    }

    private static LineRow mapLineRow(ResultSet rs) throws SQLException {
        InvoiceLine line = new InvoiceLine(
                rs.getString("itemId"), rs.getString("name"), rs.getString("unit"),
                Money.parse(rs.getString("price")), rs.getDouble("taxRatePercent"),
                rs.getDouble("quantity"), Money.parse(rs.getString("amount")),
                Money.parse(rs.getString("tax")));
        return new LineRow(rs.getString("invoiceNo"), line);
    }

    private static Invoice mapHeaderRow(ResultSet rs, Map<String, List<InvoiceLine>> linesByInvoice,
                                        BranchService branches) throws SQLException {
        String invoiceNo = rs.getString("invoiceNo");
        List<InvoiceLine> lines = linesByInvoice.getOrDefault(invoiceNo, new ArrayList<>());
        LocalDateTime when = parseStamp(rs.getString("dateTime"));
        String branchId = rs.getString("branchId");
        String placeOfSupply = readOptionalString(rs, "placeOfSupplyStateCode");
        String branchStateCode = "";
        if (branches != null) {
            try {
                grocery.model.Branch b = branches.findById(branchId);
                if (b != null) {
                    branchStateCode = b.getStateCode();
                }
            } catch (RuntimeException ignore) {
                // Best-effort - if branch state is unknown at load time, we fall through
                // to intra-state (empty branchStateCode -> interState=false).
            }
        }
        return new Invoice(invoiceNo, branchId, rs.getString("cashierUsername"), when,
                rs.getString("customerName"), rs.getString("customerPhone"), rs.getString("paymentMode"),
                lines, Money.parse(rs.getString("discount")), Money.parse(rs.getString("amountPaid")),
                placeOfSupply, branchStateCode);
    }

    /** Reads {@code column} as a string, returning "" if the column doesn't exist yet on very old DBs. */
    private static String readOptionalString(ResultSet rs, String column) {
        try {
            String v = rs.getString(column);
            return v == null ? "" : v;
        } catch (SQLException e) {
            return "";
        }
    }

    private static LocalDateTime parseStamp(String s) {
        try {
            return LocalDateTime.parse(s, STAMP);
        } catch (RuntimeException e) {
            return Time.now();
        }
    }

    // ---------------- legacy CSV parsing (one-time SQLite migration only) ----------------

    /**
     * Parses pre-SQLite {@code invoices.csv} + {@code invoice_lines.csv}, tolerating
     * three historical shapes seen in the wild:
     *   9 cols  = pre-multi-branch (no branch/cashier/amountPaid)
     *   11 cols = post-multi-branch, pre-amountPaid
     *   12 cols = current
     * Only ever called by {@link SqliteMigration}.
     */
    public static List<Invoice> parseLegacyCsv(File headerFile, File linesFile, String defaultBranchId) {
        List<Invoice> out = new ArrayList<>();
        if (!headerFile.exists() || !linesFile.exists()) {
            return out;
        }

        Map<String, List<InvoiceLine>> linesByInvoice = new HashMap<>();
        try (BufferedReader r = new BufferedReader(new FileReader(linesFile, StandardCharsets.UTF_8))) {
            String row = r.readLine(); // header
            while ((row = r.readLine()) != null) {
                if (row.trim().isEmpty()) {
                    continue;
                }
                List<String> f = Csv.parse(row);
                if (f.size() < 9) {
                    continue;
                }
                InvoiceLine line = new InvoiceLine(
                        f.get(1), f.get(2), f.get(3), Money.parse(f.get(4)),
                        parseDouble(f.get(5)), parseDouble(f.get(6)),
                        Money.parse(f.get(7)), Money.parse(f.get(8)));
                linesByInvoice.computeIfAbsent(f.get(0), k -> new ArrayList<>()).add(line);
            }
        } catch (IOException e) {
            grocery.util.Log.warn("Could not parse legacy invoice_lines.csv: " + e.getMessage(), e);
            return out;
        }

        try (BufferedReader r = new BufferedReader(new FileReader(headerFile, StandardCharsets.UTF_8))) {
            String row = r.readLine(); // header
            while ((row = r.readLine()) != null) {
                if (row.trim().isEmpty()) {
                    continue;
                }
                List<String> f = Csv.parse(row);
                String invoiceNo = f.get(0);
                List<InvoiceLine> lines = linesByInvoice.getOrDefault(invoiceNo, new ArrayList<>());
                if (f.size() >= 12) {
                    LocalDateTime when = parseStamp(f.get(3));
                    out.add(new Invoice(invoiceNo, f.get(1), f.get(2), when,
                            f.get(4), f.get(5), f.get(6), lines, Money.parse(f.get(8)), Money.parse(f.get(11))));
                } else if (f.size() >= 11) {
                    LocalDateTime when = parseStamp(f.get(3));
                    out.add(new Invoice(invoiceNo, f.get(1), f.get(2), when,
                            f.get(4), f.get(5), f.get(6), lines, Money.parse(f.get(8))));
                } else if (f.size() >= 9) {
                    LocalDateTime when = parseStamp(f.get(1));
                    out.add(new Invoice(invoiceNo, defaultBranchId, "legacy", when,
                            f.get(2), f.get(3), f.get(4), lines, Money.parse(f.get(6))));
                }
            }
        } catch (IOException e) {
            grocery.util.Log.warn("Could not parse legacy invoices.csv: " + e.getMessage(), e);
        }
        return out;
    }

    private static double parseDouble(String s) {
        try {
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
