package grocery.model;

/**
 * What a signed-in user is allowed to do.
 *
 * <ul>
 *   <li>{@code ADMIN}   - everything, across every branch: users, branches, audit log, backups, settings.</li>
 *   <li>{@code MANAGER} - full run of their one assigned branch (products, billing, invoices, dashboard)
 *                         but no user/branch management.</li>
 *   <li>{@code CASHIER} - billing and viewing invoices in their assigned branch only; cannot edit products.</li>
 * </ul>
 */
public enum Role {
    ADMIN,
    MANAGER,
    CASHIER;

    public boolean canManageCatalogue() {
        return this == ADMIN || this == MANAGER;
    }

    public boolean isAdmin() {
        return this == ADMIN;
    }

    public static Role parse(String s) {
        if (s == null) {
            return CASHIER;
        }
        try {
            return Role.valueOf(s.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return CASHIER;
        }
    }
}
