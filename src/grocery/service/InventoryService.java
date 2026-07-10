package grocery.service;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import grocery.model.Item;
import grocery.util.Csv;
import grocery.util.Db;
import grocery.util.Money;

/**
 * Owns the product catalogue / stock for every branch (each {@link Item}
 * carries its own {@code branchId}). Loads the full catalogue into memory at
 * startup and keeps it in sync with the {@code items} table on every change.
 */
public class InventoryService {

    public static final double DEFAULT_REORDER_LEVEL = 10;

    private final Db db;
    private final String defaultBranchId;
    private final List<Item> items = new ArrayList<>();

    public InventoryService(Db db, String defaultBranchId) {
        this.db = db;
        this.defaultBranchId = defaultBranchId;
        loadFromDb();
        if (items.isEmpty()) {
            seed();
        }
    }

    // ---------------- reads ----------------

    public synchronized List<Item> getAll(String branchId) {
        List<Item> out = new ArrayList<>();
        for (Item it : items) {
            if (it.getBranchId().equalsIgnoreCase(branchId)) {
                out.add(it);
            }
        }
        return out;
    }

    /** Looks up an item by id regardless of branch - only for internal use (ids are globally unique). */
    public synchronized Item findById(String id) {
        if (id == null) {
            return null;
        }
        for (Item it : items) {
            if (it.getId().equalsIgnoreCase(id)) {
                return it;
            }
        }
        return null;
    }

    /** Looks up an item by id, but only if it belongs to the given branch. */
    public synchronized Item findInBranch(String branchId, String id) {
        Item it = findById(id);
        return (it != null && it.getBranchId().equalsIgnoreCase(branchId)) ? it : null;
    }

    public synchronized Item findByBarcode(String branchId, String barcode) {
        if (barcode == null || barcode.trim().isEmpty()) {
            return null;
        }
        String b = barcode.trim();
        for (Item it : items) {
            if (it.getBranchId().equalsIgnoreCase(branchId) && it.getBarcode().equalsIgnoreCase(b)) {
                return it;
            }
        }
        return null;
    }

    /** Case-insensitive search across id / name / category, scoped to one branch. */
    public synchronized List<Item> search(String branchId, String query) {
        List<Item> scoped = getAll(branchId);
        if (query == null || query.trim().isEmpty()) {
            return scoped;
        }
        String q = query.trim().toLowerCase(Locale.ROOT);
        List<Item> out = new ArrayList<>();
        for (Item it : scoped) {
            if (it.getId().toLowerCase(Locale.ROOT).contains(q)
                    || it.getName().toLowerCase(Locale.ROOT).contains(q)
                    || it.getCategory().toLowerCase(Locale.ROOT).contains(q)) {
                out.add(it);
            }
        }
        return out;
    }

    // ---------------- writes ----------------

    public synchronized void add(Item item) {
        // Assigning the auto-id here (rather than at the call site) keeps "pick the next free
        // id" and "insert it" inside one critical section, so two concurrent creates can't both
        // grab the same generated id.
        if (item.getId() == null || item.getId().isEmpty()) {
            item.setId(nextId());
        }
        if (findById(item.getId()) != null) {
            throw new IllegalArgumentException("An item with id '" + item.getId() + "' already exists.");
        }
        items.add(item);
        insert(item);
    }

    public synchronized void update(String branchId, Item item) {
        for (int i = 0; i < items.size(); i++) {
            Item existing = items.get(i);
            if (existing.getId().equalsIgnoreCase(item.getId())) {
                if (!existing.getBranchId().equalsIgnoreCase(branchId)) {
                    throw new IllegalArgumentException("That item does not belong to this branch.");
                }
                items.set(i, item);
                updateRow(item);
                return;
            }
        }
        throw new IllegalArgumentException("No item with id '" + item.getId() + "'.");
    }

    public synchronized void delete(String branchId, String id) {
        boolean removed = items.removeIf(it ->
                it.getId().equalsIgnoreCase(id) && it.getBranchId().equalsIgnoreCase(branchId));
        if (removed) {
            db.update("DELETE FROM items WHERE id=? AND branchId=?", ps -> {
                ps.setString(1, id);
                ps.setString(2, branchId);
            });
        }
    }

    /** One line of a stock reservation request: which item, how much. */
    public static final class StockRequest {
        public final String itemId;
        public final double quantity;

        public StockRequest(String itemId, double quantity) {
            this.itemId = itemId;
            this.quantity = quantity;
        }
    }

    /**
     * Atomically validate and decrement stock for a whole cart in one step.
     * Either every line succeeds or none do, and duplicate item ids within
     * the request are summed before checking - this is what stops two
     * simultaneous checkouts (two tills) from both passing a stock check and
     * overselling the same item.
     *
     * @return the affected items, keyed by item id, with their post-sale stock already applied.
     */
    public synchronized Map<String, Item> reserveStock(String branchId, List<StockRequest> requests) {
        Map<String, Double> totalRequested = new LinkedHashMap<>();
        for (StockRequest req : requests) {
            if (req.quantity <= 0) {
                throw new IllegalStateException("Quantity must be greater than zero.");
            }
            totalRequested.merge(req.itemId, req.quantity, Double::sum);
        }

        Map<String, Item> resolved = new LinkedHashMap<>();
        for (Map.Entry<String, Double> e : totalRequested.entrySet()) {
            Item item = findInBranch(branchId, e.getKey());
            if (item == null) {
                throw new IllegalStateException("Unknown item: " + e.getKey());
            }
            if (e.getValue() > item.getStock()) {
                throw new IllegalStateException(
                        "Not enough stock for '" + item.getName()
                                + "'. Available: " + trim(item.getStock())
                                + ", requested: " + trim(e.getValue()) + ".");
            }
            resolved.put(e.getKey(), item);
        }

        // Every line checked out fine - now commit all the decrements together.
        for (Map.Entry<String, Item> e : resolved.entrySet()) {
            Item item = e.getValue();
            item.setStock(item.getStock() - totalRequested.get(e.getKey()));
        }
        db.inTransaction(() -> {
            for (Item item : resolved.values()) {
                updateStock(item);
            }
        });
        return resolved;
    }

    /**
     * Atomically put stock back on the shelf for a whole refund in one step - the
     * mirror of {@link #reserveStock}. Shares the same monitor so a refund cannot
     * race an in-flight checkout and leave stock inconsistent. Unknown items are
     * skipped (e.g. an item was deleted since the original sale) rather than
     * failing the whole refund, since the refund itself must still complete.
     */
    public synchronized void restoreStock(String branchId, List<StockRequest> requests) {
        Map<String, Double> totals = new LinkedHashMap<>();
        for (StockRequest req : requests) {
            if (req.quantity <= 0) {
                continue;
            }
            totals.merge(req.itemId, req.quantity, Double::sum);
        }
        List<Item> changed = new ArrayList<>();
        for (Map.Entry<String, Double> e : totals.entrySet()) {
            Item item = findInBranch(branchId, e.getKey());
            if (item == null) {
                continue;
            }
            item.setStock(item.getStock() + e.getValue());
            changed.add(item);
        }
        if (!changed.isEmpty()) {
            db.inTransaction(() -> {
                for (Item item : changed) {
                    updateStock(item);
                }
            });
        }
    }

    /** Duplicate every item in {@code fromBranchId} into {@code toBranchId} with fresh ids and zero stock. */
    public synchronized List<Item> cloneCatalogue(String fromBranchId, String toBranchId) {
        List<Item> created = new ArrayList<>();
        for (Item src : getAll(fromBranchId)) {
            Item copy = new Item(nextId(), toBranchId, src.getName(), src.getCategory(), src.getUnit(),
                    src.getPrice(), src.getTaxRatePercent(), 0, src.getBarcode(), src.getReorderLevel());
            items.add(copy);
            created.add(copy);
        }
        db.inTransaction(() -> {
            for (Item copy : created) {
                insert(copy);
            }
        });
        return created;
    }

    /** Generate the next free id of the form ITM-### (globally unique across all branches). */
    public synchronized String nextId() {
        int max = 0;
        for (Item it : items) {
            String id = it.getId();
            int dash = id.lastIndexOf('-');
            if (dash >= 0) {
                try {
                    max = Math.max(max, Integer.parseInt(id.substring(dash + 1)));
                } catch (NumberFormatException ignore) {
                    // non-numeric id, skip
                }
            }
        }
        return String.format("ITM-%03d", max + 1);
    }

    // ---------------- persistence ----------------

    private void insert(Item it) {
        db.update("INSERT INTO items(id, branchId, name, category, unit, price, taxRatePercent, " +
                "stock, barcode, reorderLevel) VALUES(?,?,?,?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, it.getId());
            ps.setString(2, it.getBranchId());
            ps.setString(3, it.getName());
            ps.setString(4, it.getCategory());
            ps.setString(5, it.getUnit());
            ps.setString(6, Money.format(it.getPrice()));
            ps.setDouble(7, it.getTaxRatePercent());
            ps.setDouble(8, it.getStock());
            ps.setString(9, it.getBarcode());
            ps.setDouble(10, it.getReorderLevel());
        });
    }

    private void updateRow(Item it) {
        db.update("UPDATE items SET branchId=?, name=?, category=?, unit=?, price=?, taxRatePercent=?, " +
                "stock=?, barcode=?, reorderLevel=? WHERE id=?", ps -> {
            ps.setString(1, it.getBranchId());
            ps.setString(2, it.getName());
            ps.setString(3, it.getCategory());
            ps.setString(4, it.getUnit());
            ps.setString(5, Money.format(it.getPrice()));
            ps.setDouble(6, it.getTaxRatePercent());
            ps.setDouble(7, it.getStock());
            ps.setString(8, it.getBarcode());
            ps.setDouble(9, it.getReorderLevel());
            ps.setString(10, it.getId());
        });
    }

    private void updateStock(Item it) {
        db.update("UPDATE items SET stock=? WHERE id=?", ps -> {
            ps.setDouble(1, it.getStock());
            ps.setString(2, it.getId());
        });
    }

    private void loadFromDb() {
        items.addAll(db.query("SELECT * FROM items", InventoryService::mapRow));
    }

    private static Item mapRow(ResultSet rs) throws SQLException {
        return new Item(rs.getString("id"), rs.getString("branchId"), rs.getString("name"),
                rs.getString("category"), rs.getString("unit"), Money.parse(rs.getString("price")),
                rs.getDouble("taxRatePercent"), rs.getDouble("stock"), rs.getString("barcode"),
                rs.getDouble("reorderLevel"));
    }

    private String trim(double d) {
        if (d == Math.floor(d)) {
            return String.valueOf((long) d);
        }
        return String.valueOf(d);
    }

    /** A realistic starter catalogue so the app is usable immediately. */
    private void seed() {
        List<Item> fresh = new ArrayList<>();
        seedAdd(fresh, "ITM-001", "Basmati Rice 1kg", "Grains", "pkt", 120.00, 5, 60, "8901000000017");
        seedAdd(fresh, "ITM-002", "Toor Dal 1kg", "Pulses", "pkt", 145.00, 5, 40, "8901000000024");
        seedAdd(fresh, "ITM-003", "Sunflower Oil 1L", "Oils", "ltr", 165.00, 5, 35, "8901000000031");
        seedAdd(fresh, "ITM-004", "Aashirvaad Atta 5kg", "Grains", "pkt", 285.00, 5, 25, "8901000000048");
        seedAdd(fresh, "ITM-005", "Sugar 1kg", "Essentials", "kg", 48.00, 5, 80, "8901000000055");
        seedAdd(fresh, "ITM-006", "Iodised Salt 1kg", "Essentials", "pkt", 22.00, 5, 90, "8901000000062");
        seedAdd(fresh, "ITM-007", "Amul Butter 100g", "Dairy", "pc", 58.00, 12, 30, "8901000000079");
        seedAdd(fresh, "ITM-008", "Milk 500ml", "Dairy", "pkt", 28.00, 0, 50, "8901000000086");
        seedAdd(fresh, "ITM-009", "Brown Eggs (6)", "Dairy", "pkt", 72.00, 0, 40, "8901000000093");
        seedAdd(fresh, "ITM-010", "Tata Tea Gold 250g", "Beverages", "pkt", 140.00, 5, 28, "8901000000109");
        seedAdd(fresh, "ITM-011", "Nescafe Coffee 50g", "Beverages", "pc", 165.00, 18, 22, "8901000000116");
        seedAdd(fresh, "ITM-012", "Maggi Noodles (4 pack)", "Snacks", "pkt", 56.00, 12, 45, "8901000000123");
        seedAdd(fresh, "ITM-013", "Britannia Biscuits", "Snacks", "pkt", 30.00, 18, 60, "8901000000130");
        seedAdd(fresh, "ITM-014", "Lays Chips", "Snacks", "pc", 20.00, 18, 70, "8901000000147");
        seedAdd(fresh, "ITM-015", "Colgate Toothpaste 100g", "Personal Care", "pc", 92.00, 18, 33, "8901000000154");
        seedAdd(fresh, "ITM-016", "Lifebuoy Soap", "Personal Care", "pc", 35.00, 18, 50, "8901000000161");
        seedAdd(fresh, "ITM-017", "Surf Excel 1kg", "Household", "pkt", 130.00, 18, 27, "8901000000178");
        seedAdd(fresh, "ITM-018", "Vim Dishwash Bar", "Household", "pc", 20.00, 18, 55, "8901000000185");
        seedAdd(fresh, "ITM-019", "Onion 1kg", "Vegetables", "kg", 40.00, 0, 100, "8901000000192");
        seedAdd(fresh, "ITM-020", "Tomato 1kg", "Vegetables", "kg", 35.00, 0, 100, "8901000000208");
        seedAdd(fresh, "ITM-021", "Potato 1kg", "Vegetables", "kg", 32.00, 0, 100, "8901000000215");
        seedAdd(fresh, "ITM-022", "Banana 1dozen", "Fruits", "dozen", 60.00, 0, 40, "8901000000222");
        seedAdd(fresh, "ITM-023", "Apple 1kg", "Fruits", "kg", 180.00, 0, 30, "8901000000239");
        seedAdd(fresh, "ITM-024", "Whole Wheat Bread 400g", "Bakery", "pkt", 45.00, 5, 30, "8901000000246");
        seedAdd(fresh, "ITM-025", "Milk Bread 400g", "Bakery", "pkt", 40.00, 5, 25, "8901000000253");
        seedAdd(fresh, "ITM-026", "Rusk 200g", "Bakery", "pkt", 35.00, 12, 40, "8901000000260");
        seedAdd(fresh, "ITM-027", "Frozen Green Peas 500g", "Frozen Foods", "pkt", 90.00, 5, 20, "8901000000277");
        seedAdd(fresh, "ITM-028", "Frozen Paratha (5pc)", "Frozen Foods", "pkt", 120.00, 12, 18, "8901000000284");
        seedAdd(fresh, "ITM-029", "Ice Cream Tub 700ml", "Frozen Foods", "pc", 180.00, 18, 15, "8901000000291");
        seedAdd(fresh, "ITM-030", "Harpic Toilet Cleaner 500ml", "Household", "pc", 95.00, 18, 25, "8901000000307");
        seedAdd(fresh, "ITM-031", "Colin Glass Cleaner 500ml", "Household", "pc", 85.00, 18, 20, "8901000000314");
        seedAdd(fresh, "ITM-032", "Mr. Clean Floor Cleaner 1L", "Household", "pc", 150.00, 18, 18, "8901000000321");
        seedAdd(fresh, "ITM-033", "Garbage Bags (30pc)", "Household", "pkt", 110.00, 18, 30, "8901000000338");
        seedAdd(fresh, "ITM-034", "Candles (Pack of 6)", "Household", "pkt", 60.00, 12, 25, "8901000000482");
        seedAdd(fresh, "ITM-035", "Head & Shoulders Shampoo 180ml", "Personal Care", "pc", 210.00, 18, 22, "8901000000345");
        seedAdd(fresh, "ITM-036", "Dove Soap", "Personal Care", "pc", 55.00, 18, 45, "8901000000352");
        seedAdd(fresh, "ITM-037", "Parachute Coconut Oil 200ml", "Personal Care", "pc", 130.00, 18, 28, "8901000000369");
        seedAdd(fresh, "ITM-038", "Pampers Diapers (M, 20pc)", "Baby Care", "pkt", 450.00, 12, 15, "8901000000376");
        seedAdd(fresh, "ITM-039", "Johnson's Baby Powder 200g", "Baby Care", "pc", 180.00, 18, 20, "8901000000383");
        seedAdd(fresh, "ITM-040", "Cerelac Baby Food 300g", "Baby Care", "pc", 260.00, 5, 18, "8901000000390");
        seedAdd(fresh, "ITM-041", "Dairy Milk Chocolate 55g", "Snacks", "pc", 50.00, 18, 60, "8901000000406");
        seedAdd(fresh, "ITM-042", "Kurkure 90g", "Snacks", "pkt", 20.00, 18, 70, "8901000000413");
        seedAdd(fresh, "ITM-043", "Haldiram's Namkeen 200g", "Snacks", "pkt", 75.00, 12, 40, "8901000000420");
        seedAdd(fresh, "ITM-044", "Real Fruit Juice 1L", "Beverages", "pkt", 120.00, 12, 25, "8901000000437");
        seedAdd(fresh, "ITM-045", "Coca-Cola 750ml", "Beverages", "pc", 45.00, 28, 48, "8901000000444");
        seedAdd(fresh, "ITM-046", "Bisleri Water 1L", "Beverages", "pc", 20.00, 18, 90, "8901000000451");
        seedAdd(fresh, "ITM-047", "A4 Notebook", "Stationery", "pc", 60.00, 12, 35, "8901000000468");
        seedAdd(fresh, "ITM-048", "Ball Pen (Pack of 5)", "Stationery", "pkt", 40.00, 12, 50, "8901000000475");
        items.addAll(fresh);
        db.inTransaction(() -> {
            for (Item it : fresh) {
                insert(it);
            }
        });
    }

    private void seedAdd(List<Item> into, String id, String name, String category, String unit,
                         double price, double tax, double stock, String barcode) {
        into.add(new Item(id, defaultBranchId, name, category, unit, Money.of(price), tax, stock,
                barcode, DEFAULT_REORDER_LEVEL));
    }

    // ---------------- legacy CSV parsing (one-time SQLite migration only) ----------------

    /**
     * Parses a pre-SQLite {@code items.csv}, tolerating the pre-multi-branch
     * 7-column shape (assigns every row to {@code defaultBranchId}) as well as
     * the current 10-column shape. Only ever called by {@link SqliteMigration}.
     */
    public static List<Item> parseLegacyCsv(File file, String defaultBranchId) {
        List<Item> out = new ArrayList<>();
        if (!file.exists()) {
            return out;
        }
        try (BufferedReader r = new BufferedReader(new FileReader(file, StandardCharsets.UTF_8))) {
            String line = r.readLine(); // header
            Boolean legacyFormat = null;
            while ((line = r.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }
                List<String> f = Csv.parse(line);
                if (legacyFormat == null) {
                    legacyFormat = f.size() < 10;
                }
                if (legacyFormat && f.size() >= 7) {
                    out.add(new Item(
                            f.get(0), defaultBranchId, f.get(1), f.get(2), f.get(3),
                            Money.parse(f.get(4)), parseDouble(f.get(5)), parseDouble(f.get(6)),
                            "", DEFAULT_REORDER_LEVEL));
                } else if (!legacyFormat && f.size() >= 10) {
                    out.add(new Item(
                            f.get(0), f.get(1), f.get(2), f.get(3), f.get(4),
                            Money.parse(f.get(5)), parseDouble(f.get(6)), parseDouble(f.get(7)),
                            f.get(8), parseDouble(f.get(9))));
                }
            }
        } catch (IOException e) {
            System.err.println("Could not parse legacy items.csv: " + e.getMessage());
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
