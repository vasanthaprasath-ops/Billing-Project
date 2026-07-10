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

import grocery.auth.PasswordHasher;
import grocery.model.Role;
import grocery.model.User;
import grocery.util.Csv;
import grocery.util.Db;

/**
 * Owns the list of user accounts. On a brand new install (no users in the
 * database yet) a single {@code admin} account is created automatically with
 * a random password, which is printed to the console once - see
 * {@link #consumeBootstrapPassword()}.
 */
public class UserService {

    private final Db db;
    private final List<User> users = new ArrayList<>();
    private String bootstrapPassword;

    public UserService(Db db) {
        this.db = db;
        loadFromDb();
        if (users.isEmpty()) {
            String password = PasswordHasher.randomPassword();
            User admin = new User("admin", PasswordHasher.hash(password), "Administrator",
                    Role.ADMIN, null, true, true);
            users.add(admin);
            insert(admin);
            this.bootstrapPassword = password;
        }
    }

    /** Non-null exactly once, right after a fresh admin account was created on this run. */
    public String consumeBootstrapPassword() {
        String p = bootstrapPassword;
        bootstrapPassword = null;
        return p;
    }

    public synchronized List<User> getAll() {
        return new ArrayList<>(users);
    }

    public synchronized User findByUsername(String username) {
        if (username == null) {
            return null;
        }
        for (User u : users) {
            if (u.getUsername().equalsIgnoreCase(username)) {
                return u;
            }
        }
        return null;
    }

    public synchronized User authenticate(String username, String password) {
        User u = findByUsername(username);
        if (u == null || !u.isActive() || password == null) {
            return null;
        }
        return PasswordHasher.verify(password, u.getPasswordHash()) ? u : null;
    }

    public synchronized void add(User user) {
        if (findByUsername(user.getUsername()) != null) {
            throw new IllegalArgumentException("A user named '" + user.getUsername() + "' already exists.");
        }
        users.add(user);
        insert(user);
    }

    public synchronized void update(User user) {
        for (int i = 0; i < users.size(); i++) {
            if (users.get(i).getUsername().equalsIgnoreCase(user.getUsername())) {
                users.set(i, user);
                updateRow(user);
                return;
            }
        }
        throw new IllegalArgumentException("No user named '" + user.getUsername() + "'.");
    }

    // ---------------- persistence ----------------

    private void insert(User u) {
        db.update("INSERT INTO users(username, passwordHash, fullName, role, branchId, active, " +
                "mustChangePassword) VALUES(?,?,?,?,?,?,?)", ps -> {
            ps.setString(1, u.getUsername());
            ps.setString(2, u.getPasswordHash());
            ps.setString(3, u.getFullName());
            ps.setString(4, u.getRole().name());
            ps.setString(5, u.getBranchId());
            ps.setInt(6, u.isActive() ? 1 : 0);
            ps.setInt(7, u.isMustChangePassword() ? 1 : 0);
        });
    }

    private void updateRow(User u) {
        db.update("UPDATE users SET passwordHash=?, fullName=?, role=?, branchId=?, active=?, " +
                "mustChangePassword=? WHERE username=?", ps -> {
            ps.setString(1, u.getPasswordHash());
            ps.setString(2, u.getFullName());
            ps.setString(3, u.getRole().name());
            ps.setString(4, u.getBranchId());
            ps.setInt(5, u.isActive() ? 1 : 0);
            ps.setInt(6, u.isMustChangePassword() ? 1 : 0);
            ps.setString(7, u.getUsername());
        });
    }

    private void loadFromDb() {
        users.addAll(db.query("SELECT * FROM users", UserService::mapRow));
    }

    private static User mapRow(ResultSet rs) throws SQLException {
        return new User(rs.getString("username"), rs.getString("passwordHash"), rs.getString("fullName"),
                Role.parse(rs.getString("role")), rs.getString("branchId"), rs.getInt("active") != 0,
                rs.getInt("mustChangePassword") != 0);
    }

    // ---------------- legacy CSV parsing (one-time SQLite migration only) ----------------

    /** Parses a pre-SQLite {@code users.csv}. Only ever called by {@link SqliteMigration}. */
    public static List<User> parseLegacyCsv(File file) {
        List<User> out = new ArrayList<>();
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
                String branchId = f.get(4).isEmpty() ? null : f.get(4);
                out.add(new User(f.get(0), f.get(1), f.get(2), Role.parse(f.get(3)), branchId,
                        Boolean.parseBoolean(f.get(5)), Boolean.parseBoolean(f.get(6))));
            }
        } catch (IOException e) {
            System.err.println("Could not parse legacy users.csv: " + e.getMessage());
        }
        return out;
    }
}
