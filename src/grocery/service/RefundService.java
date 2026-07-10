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
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.model.Item;
import grocery.model.Refund;
import grocery.util.Csv;
import grocery.util.Db;
import grocery.util.Money;

/**
 * Owns customer returns / refunds. Backed by two tables mirroring the invoice
 * store ({@code refunds} header + {@code refund_lines}) so backups, the
 * dashboard and the Z-report can all treat refunds as first-class rows.
 * <p>
 * Correctness properties:
 * <ul>
 *   <li>Every step of {@link #createRefund} runs inside one monitor - allocating
 *       the refund number, checking already-refunded quantities against the
 *       original invoice, and restocking - so two tills refunding the same
 *       invoice at the same time cannot both over-refund a line.</li>
 *   <li>Stock is restored through {@link InventoryService#restoreStock}, which
 *       shares the same lock as {@code reserveStock} - so a refund can never
 *       race an in-flight checkout and leave stock inconsistent.</li>
 *   <li>The refund header and its line rows commit in a single transaction, so
 *       a crash mid-write can never leave one without the other.</li>
 * </ul>
 */
public class RefundService {

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    private final Db db;
    private final List<Refund> refunds = new ArrayList<>();

    public RefundService(Db db) {
        this.db = db;
        loadFromDb();
    }

    // ---------------- reads ----------------

    public synchronized List<Refund> getAll() {
        List<Refund> out = new ArrayList<>(refunds);
        out.sort((a, b) -> b.getDateTime().compareTo(a.getDateTime()));
        return out;
    }

    public synchronized List<Refund> getAllForBranch(String branchId) {
        List<Refund> out = new ArrayList<>();
        for (Refund r : refunds) {
            if (r.getBranchId().equalsIgnoreCase(branchId)) {
                out.add(r);
            }
        }
        out.sort((a, b) -> b.getDateTime().compareTo(a.getDateTime()));
        return out;
    }

    public synchronized Refund findByNo(String refundNo) {
        for (Refund r : refunds) {
            if (r.getRefundNo().equalsIgnoreCase(refundNo)) {
                return r;
            }
        }
        return null;
    }

    /**
     * How much of each line on the given invoice has already been returned.
     * Map key = itemId, value = total refunded quantity across every refund
     * that references this invoice. Callers subtract this from the invoice's
     * original quantity to know what is still refundable.
     */
    public synchronized Map<String, Double> refundedQuantitiesFor(String invoiceNo) {
        Map<String, Double> out = new HashMap<>();
        for (Refund r : refunds) {
            if (!r.getOriginalInvoiceNo().equalsIgnoreCase(invoiceNo)) {
                continue;
            }
            for (InvoiceLine line : r.getLines()) {
                out.merge(line.getItemId(), line.getQuantity(), Double::sum);
            }
        }
        return out;
    }

    // ---------------- write ----------------

    /** One requested return line: which item on the original invoice, how much of it. */
    public static final class LineRequest {
        public final String itemId;
        public final double quantity;

        public LineRequest(String itemId, double quantity) {
            this.itemId = itemId;
            this.quantity = quantity;
        }
    }

    /**
     * Build a refund from a set of return lines against an existing invoice.
     * Enforces per-line "remaining refundable" quantities atomically with the
     * write, restores stock, and persists both tables. Throws
     * {@link IllegalStateException} with a customer-friendly message on any
     * rule violation.
     */
    public synchronized Refund createRefund(Invoice original, String cashierUsername,
                                            List<LineRequest> requests, String reason,
                                            InventoryService inventory) {
        if (original == null) {
            throw new IllegalStateException("Unknown invoice - cannot process a return without it.");
        }
        if (requests == null || requests.isEmpty()) {
            throw new IllegalStateException("Pick at least one line to return.");
        }

        // Sum requested qty per item so a client that duplicated an item id can't slip
        // past the remaining-refundable check by splitting it across two entries.
        Map<String, Double> requested = new LinkedHashMap<>();
        for (LineRequest req : requests) {
            if (req.quantity <= 0) {
                continue; // silently skip zeros - the modal often sends every line
            }
            requested.merge(req.itemId, req.quantity, Double::sum);
        }
        if (requested.isEmpty()) {
            throw new IllegalStateException("Enter a quantity for at least one line.");
        }

        Map<String, Double> alreadyRefunded = refundedQuantitiesFor(original.getInvoiceNo());
        Map<String, InvoiceLine> originalById = new LinkedHashMap<>();
        for (InvoiceLine line : original.getLines()) {
            originalById.merge(line.getItemId(), line, RefundService::mergeLines);
        }

        // Validate every requested item exists on the invoice and does not exceed
        // its remaining (originally-sold minus already-refunded) quantity.
        List<InvoiceLine> refundLines = new ArrayList<>();
        List<InventoryService.StockRequest> restock = new ArrayList<>();
        for (Map.Entry<String, Double> e : requested.entrySet()) {
            InvoiceLine src = originalById.get(e.getKey());
            if (src == null) {
                throw new IllegalStateException("Item '" + e.getKey() + "' was not on this bill.");
            }
            double remaining = src.getQuantity() - alreadyRefunded.getOrDefault(e.getKey(), 0.0);
            double qty = e.getValue();
            if (qty > remaining + 1e-9) {
                throw new IllegalStateException("Cannot return " + trim(qty) + " " + src.getUnit()
                        + " of '" + src.getName() + "' - only " + trim(remaining) + " remains refundable.");
            }
            BigDecimal lineAmount = Money.scale(src.getPrice().multiply(BigDecimal.valueOf(qty)));
            BigDecimal lineTax = Money.scale(lineAmount.multiply(BigDecimal.valueOf(src.getTaxRatePercent()))
                    .divide(BigDecimal.valueOf(100)));
            refundLines.add(new InvoiceLine(src.getItemId(), src.getName(), src.getUnit(),
                    src.getPrice(), src.getTaxRatePercent(), qty, lineAmount, lineTax));
            restock.add(new InventoryService.StockRequest(src.getItemId(), qty));
        }

        Refund refund = new Refund(nextRefundNoLocked(), original.getInvoiceNo(),
                original.getBranchId(), cashierUsername, Time.now(), refundLines, reason);
        // One outer transaction covers restock + refund-header + refund-lines so
        // a DB error partway through can't leave stock restored without a refund
        // row (or a refund row with unrestored stock). Db.inTransaction is
        // reentrant, so restoreStock's own inTransaction just piggybacks on this.
        db.inTransaction(() -> {
            inventory.restoreStock(original.getBranchId(), restock);
            insertHeader(refund);
            for (InvoiceLine line : refund.getLines()) {
                insertLine(refund.getRefundNo(), line);
            }
        });
        // Add to memory only after commit so a rolled-back attempt doesn't leave
        // a ghost that consumes its refund number.
        refunds.add(refund);
        return refund;
    }

    /** Collapses two invoice lines with the same item id (quantity/amount/tax summed). */
    private static InvoiceLine mergeLines(InvoiceLine a, InvoiceLine b) {
        return new InvoiceLine(a.getItemId(), a.getName(), a.getUnit(), a.getPrice(), a.getTaxRatePercent(),
                a.getQuantity() + b.getQuantity(),
                a.getAmount().add(b.getAmount()),
                a.getTax().add(b.getTax()));
    }

    private String nextRefundNoLocked() {
        int max = 1000;
        for (Refund r : refunds) {
            String no = r.getRefundNo();
            int dash = no.lastIndexOf('-');
            if (dash >= 0) {
                try {
                    max = Math.max(max, Integer.parseInt(no.substring(dash + 1)));
                } catch (NumberFormatException ignore) {
                    // skip
                }
            }
        }
        return "RFD-" + (max + 1);
    }

    private String trim(double d) {
        if (d == Math.floor(d)) {
            return String.valueOf((long) d);
        }
        return String.valueOf(d);
    }

    // ---------------- persistence ----------------

    private void insertHeader(Refund r) {
        db.update("INSERT INTO refunds(refundNo, originalInvoiceNo, branchId, cashierUsername, dateTime, " +
                "refundAmount, refundTax, reason) VALUES(?,?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, r.getRefundNo());
            ps.setString(2, r.getOriginalInvoiceNo());
            ps.setString(3, r.getBranchId());
            ps.setString(4, r.getCashierUsername());
            ps.setString(5, r.getDateTime().format(STAMP));
            ps.setString(6, Money.format(r.getRefundAmount()));
            ps.setString(7, Money.format(r.getRefundTax()));
            ps.setString(8, r.getReason());
        });
    }

    private void insertLine(String refundNo, InvoiceLine line) {
        db.update("INSERT INTO refund_lines(refundNo, itemId, name, unit, price, taxRatePercent, " +
                "quantity, amount, tax) VALUES(?,?,?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, refundNo);
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
        Map<String, List<InvoiceLine>> byRefund = new HashMap<>();
        for (LineRow row : db.query("SELECT * FROM refund_lines", RefundService::mapLineRow)) {
            byRefund.computeIfAbsent(row.refundNo, k -> new ArrayList<>()).add(row.line);
        }
        for (Refund r : db.query("SELECT * FROM refunds", rs -> mapHeaderRow(rs, byRefund))) {
            refunds.add(r);
        }
    }

    private static final class LineRow {
        final String refundNo;
        final InvoiceLine line;

        LineRow(String refundNo, InvoiceLine line) {
            this.refundNo = refundNo;
            this.line = line;
        }
    }

    private static LineRow mapLineRow(ResultSet rs) throws SQLException {
        InvoiceLine line = new InvoiceLine(rs.getString("itemId"), rs.getString("name"), rs.getString("unit"),
                Money.parse(rs.getString("price")), rs.getDouble("taxRatePercent"), rs.getDouble("quantity"),
                Money.parse(rs.getString("amount")), Money.parse(rs.getString("tax")));
        return new LineRow(rs.getString("refundNo"), line);
    }

    private static Refund mapHeaderRow(ResultSet rs, Map<String, List<InvoiceLine>> byRefund) throws SQLException {
        String refundNo = rs.getString("refundNo");
        LocalDateTime when;
        try {
            when = LocalDateTime.parse(rs.getString("dateTime"), STAMP);
        } catch (RuntimeException ex) {
            when = Time.now();
        }
        List<InvoiceLine> lines = byRefund.getOrDefault(refundNo, Collections.emptyList());
        return new Refund(refundNo, rs.getString("originalInvoiceNo"), rs.getString("branchId"),
                rs.getString("cashierUsername"), when, lines, rs.getString("reason"));
    }

    // ---------------- legacy CSV parsing (one-time SQLite migration only) ----------------

    /**
     * Parses pre-SQLite {@code refunds.csv} + {@code refund_lines.csv}.
     * Only ever called by {@link SqliteMigration}.
     */
    public static List<Refund> parseLegacyCsv(File headerFile, File linesFile) {
        List<Refund> out = new ArrayList<>();
        if (!headerFile.exists() || !linesFile.exists()) {
            return out;
        }
        Map<String, List<InvoiceLine>> byRefund = new HashMap<>();
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
                InvoiceLine line = new InvoiceLine(f.get(1), f.get(2), f.get(3),
                        Money.parse(f.get(4)), parseDouble(f.get(5)), parseDouble(f.get(6)),
                        Money.parse(f.get(7)), Money.parse(f.get(8)));
                byRefund.computeIfAbsent(f.get(0), k -> new ArrayList<>()).add(line);
            }
        } catch (IOException e) {
            grocery.util.Log.warn("Could not parse legacy refund_lines.csv: " + e.getMessage(), e);
            return out;
        }
        try (BufferedReader r = new BufferedReader(new FileReader(headerFile, StandardCharsets.UTF_8))) {
            String row = r.readLine(); // header
            while ((row = r.readLine()) != null) {
                if (row.trim().isEmpty()) {
                    continue;
                }
                List<String> f = Csv.parse(row);
                if (f.size() < 8) {
                    continue;
                }
                LocalDateTime when;
                try {
                    when = LocalDateTime.parse(f.get(4), STAMP);
                } catch (RuntimeException ex) {
                    when = Time.now();
                }
                List<InvoiceLine> lines = byRefund.getOrDefault(f.get(0), Collections.emptyList());
                out.add(new Refund(f.get(0), f.get(1), f.get(2), f.get(3), when, lines, f.get(7)));
            }
        } catch (IOException e) {
            grocery.util.Log.warn("Could not parse legacy refunds.csv: " + e.getMessage(), e);
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
