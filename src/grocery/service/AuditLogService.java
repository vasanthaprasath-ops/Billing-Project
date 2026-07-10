package grocery.service;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import grocery.model.AuditEntry;
import grocery.model.Role;
import grocery.model.User;
import grocery.util.Csv;
import grocery.util.Db;

/**
 * Append-only trail of who did what. Once multiple people can sign in and
 * change prices / stock / users, "who changed this and when" stops being a
 * hypothetical question, so every sensitive action gets logged here.
 * <p>
 * Every entry is durably persisted in the {@code audit_log} table, but only
 * the most recent {@link #MAX_KEPT_IN_MEMORY} are kept in the in-memory cache
 * that {@link #recent} scans - full history is never lost, just not all held
 * in memory at once.
 */
public class AuditLogService {

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");
    private static final int MAX_KEPT_IN_MEMORY = 5000;

    private final Db db;
    private final List<AuditEntry> entries = new ArrayList<>();

    public AuditLogService(Db db) {
        this.db = db;
        loadFromDb();
    }

    public void log(User actor, String action, String details) {
        append(new AuditEntry(LocalDateTime.now(), actor.getUsername(), actor.getRole(),
                actor.getBranchId(), action, details));
    }

    public void logSystem(String action, String details) {
        append(new AuditEntry(LocalDateTime.now(), "system", null, null, action, details));
    }

    /** Most recent entries first, capped at {@code max}, optionally scoped to one branch. */
    public synchronized List<AuditEntry> recent(int max, String branchId) {
        List<AuditEntry> out = new ArrayList<>();
        for (int i = entries.size() - 1; i >= 0 && out.size() < max; i--) {
            AuditEntry e = entries.get(i);
            if (branchId == null || branchId.equalsIgnoreCase(e.getBranchId())) {
                out.add(e);
            }
        }
        return out;
    }

    private synchronized void append(AuditEntry entry) {
        entries.add(entry);
        if (entries.size() > MAX_KEPT_IN_MEMORY) {
            entries.remove(0);
        }
        db.update("INSERT INTO audit_log(\"when\", username, role, branchId, action, details) " +
                "VALUES(?,?,?,?,?,?)", ps -> {
            ps.setString(1, entry.getWhen().format(STAMP));
            ps.setString(2, entry.getUsername());
            ps.setString(3, entry.getRole() == null ? null : entry.getRole().name());
            ps.setString(4, entry.getBranchId());
            ps.setString(5, entry.getAction());
            ps.setString(6, entry.getDetails());
        });
    }

    private void loadFromDb() {
        // Only the most recent MAX_KEPT_IN_MEMORY rows - full history stays in the table.
        List<AuditEntry> tail = db.query(
                "SELECT * FROM audit_log ORDER BY id DESC LIMIT " + MAX_KEPT_IN_MEMORY,
                AuditLogService::mapRow);
        Collections.reverse(tail);
        entries.addAll(tail);
    }

    private static AuditEntry mapRow(ResultSet rs) throws SQLException {
        LocalDateTime when;
        try {
            when = LocalDateTime.parse(rs.getString("when"), STAMP);
        } catch (RuntimeException e) {
            when = LocalDateTime.now();
        }
        String roleStr = rs.getString("role");
        Role role = roleStr == null || roleStr.isEmpty() ? null : Role.parse(roleStr);
        return new AuditEntry(when, rs.getString("username"), role, rs.getString("branchId"),
                rs.getString("action"), rs.getString("details"));
    }

    // ---------------- legacy CSV parsing (one-time SQLite migration only) ----------------

    /**
     * Parses a pre-SQLite {@code audit_log.csv} in full (not capped) so the
     * migration preserves complete history. Only ever called by {@link SqliteMigration}.
     */
    public static List<AuditEntry> parseLegacyCsv(File file) {
        List<AuditEntry> out = new ArrayList<>();
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
                if (f.size() < 6) {
                    continue;
                }
                LocalDateTime when;
                try {
                    when = LocalDateTime.parse(f.get(0), STAMP);
                } catch (RuntimeException e) {
                    continue;
                }
                Role role = f.get(2).isEmpty() ? null : Role.parse(f.get(2));
                String branchId = f.get(3).isEmpty() ? null : f.get(3);
                out.add(new AuditEntry(when, f.get(1), role, branchId, f.get(4), f.get(5)));
            }
        } catch (IOException e) {
            System.err.println("Could not parse legacy audit_log.csv: " + e.getMessage());
        }
        Collections.sort(out, (a, b) -> a.getWhen().compareTo(b.getWhen()));
        return out;
    }
}
