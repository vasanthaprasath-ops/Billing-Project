package grocery.model;

/**
 * A person who can sign in. {@code branchId} is {@code null} for
 * {@link Role#ADMIN} (head-office access to every branch) and required for
 * {@code MANAGER} / {@code CASHIER}, who are pinned to one branch.
 */
public class User {

    private String username;
    private String passwordHash;
    private String fullName;
    private Role role;
    private String branchId;
    private boolean active;
    private boolean mustChangePassword;

    public User(String username, String passwordHash, String fullName, Role role,
                String branchId, boolean active, boolean mustChangePassword) {
        this.username = username;
        this.passwordHash = passwordHash;
        this.fullName = fullName;
        this.role = role;
        this.branchId = branchId;
        this.active = active;
        this.mustChangePassword = mustChangePassword;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public void setPasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }

    public String getFullName() {
        return fullName;
    }

    public void setFullName(String fullName) {
        this.fullName = fullName;
    }

    public Role getRole() {
        return role;
    }

    public void setRole(Role role) {
        this.role = role;
    }

    public String getBranchId() {
        return branchId;
    }

    public void setBranchId(String branchId) {
        this.branchId = branchId;
    }

    public boolean isActive() {
        return active;
    }

    public void setActive(boolean active) {
        this.active = active;
    }

    public boolean isMustChangePassword() {
        return mustChangePassword;
    }

    public void setMustChangePassword(boolean mustChangePassword) {
        this.mustChangePassword = mustChangePassword;
    }

    /** Whether this user may act on the given branch (ADMIN: any branch; others: only their own). */
    public boolean canAccessBranch(String otherBranchId) {
        return role == Role.ADMIN || branchId.equalsIgnoreCase(otherBranchId);
    }
}
