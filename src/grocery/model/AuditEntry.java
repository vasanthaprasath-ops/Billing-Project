package grocery.model;

import java.time.LocalDateTime;

/** One immutable line in the append-only audit trail: who did what, and when. */
public class AuditEntry {

    private final LocalDateTime when;
    private final String username;
    private final Role role;
    private final String branchId;
    private final String action;
    private final String details;

    public AuditEntry(LocalDateTime when, String username, Role role, String branchId,
                       String action, String details) {
        this.when = when;
        this.username = username;
        this.role = role;
        this.branchId = branchId;
        this.action = action;
        this.details = details;
    }

    public LocalDateTime getWhen() {
        return when;
    }

    public String getUsername() {
        return username;
    }

    public Role getRole() {
        return role;
    }

    public String getBranchId() {
        return branchId;
    }

    public String getAction() {
        return action;
    }

    public String getDetails() {
        return details;
    }
}
