package grocery.model;

import java.math.BigDecimal;

import grocery.util.Money;

/**
 * A frozen snapshot of one billed item. Unlike {@link CartLine} this does not
 * reference the live catalogue — prices are captured at the time of sale so a
 * re-printed invoice always shows what the customer actually paid.
 */
public class InvoiceLine {

    private final String itemId;
    private final String name;
    private final String unit;
    private final BigDecimal price;
    private final double taxRatePercent;
    private final double quantity;
    private final BigDecimal amount;
    private final BigDecimal tax;

    public InvoiceLine(String itemId, String name, String unit, BigDecimal price,
                       double taxRatePercent, double quantity,
                       BigDecimal amount, BigDecimal tax) {
        this.itemId = itemId;
        this.name = name;
        this.unit = unit;
        this.price = Money.scale(price);
        this.taxRatePercent = taxRatePercent;
        this.quantity = quantity;
        this.amount = Money.scale(amount);
        this.tax = Money.scale(tax);
    }

    public static InvoiceLine fromCart(CartLine line) {
        Item item = line.getItem();
        return new InvoiceLine(
                item.getId(),
                item.getName(),
                item.getUnit(),
                item.getPrice(),
                item.getTaxRatePercent(),
                line.getQuantity(),
                line.getAmount(),
                line.getTax());
    }

    public String getItemId() {
        return itemId;
    }

    public String getName() {
        return name;
    }

    public String getUnit() {
        return unit;
    }

    public BigDecimal getPrice() {
        return price;
    }

    public double getTaxRatePercent() {
        return taxRatePercent;
    }

    public double getQuantity() {
        return quantity;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public BigDecimal getTax() {
        return tax;
    }
}
