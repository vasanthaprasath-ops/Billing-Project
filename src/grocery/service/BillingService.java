package grocery.service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import grocery.model.CartLine;
import grocery.model.Invoice;
import grocery.model.InvoiceLine;
import grocery.model.Item;
import grocery.util.Money;
import grocery.util.Text;

/**
 * Turns a set of requested lines into a saved {@link Invoice}.
 *
 * The service is stateless: the cart lives on the client (the web page), and is
 * sent to the server only at checkout. The server always re-prices each line
 * from its own catalogue, so a tampered client price can never affect the bill.
 *
 * Stock is validated twice on purpose: once here (read-only, so a bad discount
 * or unknown item fails before anything is written) and again, atomically,
 * inside {@link InventoryService#reserveStock} immediately before the sale is
 * committed - stock can move between those two points if another till is
 * checking out the same item at the same time, and that second check is the
 * one that actually prevents overselling.
 */
public class BillingService {

    /** A single requested line: which item and how much of it. */
    public static class LineRequest {
        public final String itemId;
        public final double quantity;

        public LineRequest(String itemId, double quantity) {
            this.itemId = itemId;
            this.quantity = quantity;
        }
    }

    /**
     * Validate, build and persist an invoice for the given request.
     *
     * @throws IllegalStateException if the cart is empty, an item is unknown,
     *         the discount is invalid, or stock is insufficient.
     */
    public Invoice checkout(String branchId, String cashierUsername, String customerName, String customerPhone,
                            String paymentMode, BigDecimal discount, BigDecimal amountPaid,
                            List<LineRequest> requests,
                            InventoryService inventory, InvoiceStore invoiceStore) {

        if (requests == null || requests.isEmpty()) {
            throw new IllegalStateException("The cart is empty - add at least one item.");
        }

        // Resolve every requested line against the live catalogue and compute the subtotal.
        // Read-only: stock is not touched yet, so an invalid discount fails before anything commits.
        List<CartLine> cart = new ArrayList<>();
        for (LineRequest req : requests) {
            Item item = inventory.findInBranch(branchId, req.itemId);
            if (item == null) {
                throw new IllegalStateException("Unknown item: " + req.itemId);
            }
            if (req.quantity <= 0) {
                throw new IllegalStateException("Quantity for '" + item.getName() + "' must be greater than zero.");
            }
            cart.add(new CartLine(item, req.quantity));
        }

        BigDecimal subTotal = subTotal(cart);
        BigDecimal safeDiscount = discount == null ? Money.ZERO : Money.scale(discount);
        if (safeDiscount.compareTo(Money.ZERO) < 0) {
            throw new IllegalStateException("Discount cannot be negative.");
        }
        if (safeDiscount.compareTo(subTotal) > 0) {
            throw new IllegalStateException("Discount cannot be greater than the subtotal.");
        }

        // Authoritative, atomic stock check-and-decrement, right before we commit the sale.
        List<InventoryService.StockRequest> stockRequests = new ArrayList<>();
        for (LineRequest req : requests) {
            stockRequests.add(new InventoryService.StockRequest(req.itemId, req.quantity));
        }
        inventory.reserveStock(branchId, stockRequests);

        List<InvoiceLine> lines = new ArrayList<>();
        for (CartLine line : cart) {
            lines.add(InvoiceLine.fromCart(line));
        }

        String name = (customerName == null || customerName.trim().isEmpty())
                ? "Walk-in Customer" : Text.oneLine(customerName);
        String phone = Text.oneLine(customerPhone);
        String mode = (paymentMode == null || paymentMode.trim().isEmpty())
                ? "Cash" : Text.oneLine(paymentMode);

        // Cash-tendered check: only enforced when the client actually reported an amount.
        // A blank / zero value means "no tender captured" - we fall back to grandTotal in the
        // invoice constructor so change reads as zero. This keeps card / UPI flows terse.
        BigDecimal safePaid = null;
        if (amountPaid != null && amountPaid.compareTo(Money.ZERO) > 0) {
            safePaid = Money.scale(amountPaid);
        }
        return invoiceStore.createAndSave(branchId, cashierUsername, name, phone, mode, lines, safeDiscount, safePaid);
    }

    /** Backwards-compatible overload used by the demo self-test. */
    public Invoice checkout(String branchId, String cashierUsername, String customerName, String customerPhone,
                            String paymentMode, BigDecimal discount, List<LineRequest> requests,
                            InventoryService inventory, InvoiceStore invoiceStore) {
        return checkout(branchId, cashierUsername, customerName, customerPhone, paymentMode, discount,
                null, requests, inventory, invoiceStore);
    }

    public static BigDecimal subTotal(List<CartLine> cart) {
        BigDecimal sub = Money.ZERO;
        for (CartLine line : cart) {
            sub = sub.add(line.getAmount());
        }
        return Money.scale(sub);
    }
}
