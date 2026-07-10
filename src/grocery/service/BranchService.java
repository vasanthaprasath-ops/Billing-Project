package grocery.service;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import grocery.config.StoreConfig;
import grocery.model.Branch;
import grocery.util.Csv;
import grocery.util.Db;

/**
 * Owns the list of store branches. A fresh install (or one upgrading from a
 * pre-multi-branch version) always ends up with at least one branch, seeded
 * from {@code store.properties} so existing single-store setups keep working
 * without any manual setup.
 */
public class BranchService {

    private final Db db;
    private final List<Branch> branches = new ArrayList<>();

    public BranchService(Db db, StoreConfig store) {
        this.db = db;
        loadFromDb();
        if (branches.isEmpty()) {
            Branch b = new Branch("BR-001", store.getName(), store.getAddressLine1(),
                    store.getAddressLine2(), store.getPhone(), store.getGstin(), true);
            branches.add(b);
            insert(b);
        }
    }

    public synchronized List<Branch> getAll() {
        return new ArrayList<>(branches);
    }

    public synchronized Branch findById(String id) {
        if (id == null) {
            return null;
        }
        for (Branch b : branches) {
            if (b.getId().equalsIgnoreCase(id)) {
                return b;
            }
        }
        return null;
    }

    public synchronized Branch require(String id) {
        Branch b = findById(id);
        if (b == null) {
            throw new IllegalArgumentException("Unknown branch: " + id);
        }
        return b;
    }

    /** The branch that pre-existing (pre-multi-branch) data gets migrated into. */
    public synchronized String defaultBranchId() {
        return branches.get(0).getId();
    }

    public synchronized void add(Branch branch) {
        // Assigning the auto-id here (rather than at the call site) keeps "pick the next free
        // id" and "insert it" inside one critical section, so two concurrent creates can't both
        // grab the same generated id.
        if (branch.getId() == null || branch.getId().isEmpty()) {
            branch.setId(nextId());
        }
        if (findById(branch.getId()) != null) {
            throw new IllegalArgumentException("A branch with id '" + branch.getId() + "' already exists.");
        }
        branches.add(branch);
        insert(branch);
    }

    public synchronized void update(Branch branch) {
        for (int i = 0; i < branches.size(); i++) {
            if (branches.get(i).getId().equalsIgnoreCase(branch.getId())) {
                branches.set(i, branch);
                updateRow(branch);
                return;
            }
        }
        throw new IllegalArgumentException("No branch with id '" + branch.getId() + "'.");
    }

    public synchronized String nextId() {
        int max = 0;
        for (Branch b : branches) {
            int dash = b.getId().lastIndexOf('-');
            if (dash >= 0) {
                try {
                    max = Math.max(max, Integer.parseInt(b.getId().substring(dash + 1)));
                } catch (NumberFormatException ignore) {
                    // non-numeric id, skip
                }
            }
        }
        return String.format("BR-%03d", max + 1);
    }

    // ---------------- persistence ----------------

    private void insert(Branch b) {
        db.update("INSERT INTO branches(id, name, addressLine1, addressLine2, phone, gstin, active) " +
                "VALUES(?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, b.getId());
            ps.setString(2, b.getName());
            ps.setString(3, b.getAddressLine1());
            ps.setString(4, b.getAddressLine2());
            ps.setString(5, b.getPhone());
            ps.setString(6, b.getGstin());
            ps.setInt(7, b.isActive() ? 1 : 0);
        });
    }

    private void updateRow(Branch b) {
        db.update("UPDATE branches SET name=?, addressLine1=?, addressLine2=?, phone=?, gstin=?, active=? " +
                "WHERE id=?", ps -> {
            ps.setString(1, b.getName());
            ps.setString(2, b.getAddressLine1());
            ps.setString(3, b.getAddressLine2());
            ps.setString(4, b.getPhone());
            ps.setString(5, b.getGstin());
            ps.setInt(6, b.isActive() ? 1 : 0);
            ps.setString(7, b.getId());
        });
    }

    private void loadFromDb() {
        branches.addAll(db.query("SELECT * FROM branches", BranchService::mapRow));
    }

    private static Branch mapRow(ResultSet rs) throws SQLException {
        return new Branch(rs.getString("id"), rs.getString("name"), rs.getString("addressLine1"),
                rs.getString("addressLine2"), rs.getString("phone"), rs.getString("gstin"),
                rs.getInt("active") != 0);
    }

    // ---------------- legacy CSV parsing (one-time SQLite migration only) ----------------

    /** Parses a pre-SQLite {@code branches.csv}. Only ever called by {@link SqliteMigration}. */
    public static List<Branch> parseLegacyCsv(File file) {
        List<Branch> out = new ArrayList<>();
        if (!file.exists()) {
            return out;
        }
        try (BufferedReader r = new BufferedReader(new FileReader(file, StandardCharsets.UTF_8))) {
            String line = r.readLine(); // header
            while ((line = r.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }
                List<String> f = Csv.parse(line);
                if (f.size() < 7) {
                    continue;
                }
                out.add(new Branch(f.get(0), f.get(1), f.get(2), f.get(3), f.get(4), f.get(5),
                        Boolean.parseBoolean(f.get(6))));
            }
        } catch (IOException e) {
            grocery.util.Log.warn("Could not parse legacy branches.csv: " + e.getMessage(), e);
        }
        return out;
    }
}
