package grocery.model;

import java.math.BigDecimal;
import java.math.RoundingMode;

import grocery.util.Money;

/**
 * A line in the current (in-progress) bill. Holds a live reference to the
 * catalogue {@link Item} plus the quantity the customer is buying.
 */
public class CartLine {

    private final Item item;
    private double quantity;

    public CartLine(Item item, double quantity) {
        this.item = item;
        this.quantity = quantity;
    }

    public Item getItem() {
        return item;
    }

    public double getQuantity() {
        return quantity;
    }

    public void setQuantity(double quantity) {
        this.quantity = quantity;
    }

    public void addQuantity(double extra) {
        this.quantity += extra;
    }

    /** Pre-tax amount for this line = price * quantity. */
    public BigDecimal getAmount() {
        return Money.scale(item.getPrice().multiply(BigDecimal.valueOf(quantity)));
    }

    /** Tax amount for this line based on the item's GST rate. */
    public BigDecimal getTax() {
        BigDecimal rate = BigDecimal.valueOf(item.getTaxRatePercent())
                .divide(BigDecimal.valueOf(100));
        return getAmount().multiply(rate).setScale(2, RoundingMode.HALF_UP);
    }
}
