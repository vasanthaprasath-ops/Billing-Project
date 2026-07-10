package grocery.model;

import java.math.BigDecimal;

import grocery.util.Money;

/**
 * A product sold by the store (a row in one branch's catalogue / inventory).
 * Item ids are globally unique across every branch, even though each item
 * belongs to exactly one branch's catalogue.
 */
public class Item {

    private String id;
    private String branchId;
    private String name;
    private String category;
    private String unit;            // e.g. "kg", "pc", "ltr", "pkt"
    private BigDecimal price;       // selling price per unit
    private double taxRatePercent;  // GST percent applied to this item
    private double stock;           // quantity on hand
    private String barcode;         // scanned barcode / SKU, optional
    private double reorderLevel;    // dashboard flags this item once stock falls to/below this

    public Item(String id, String branchId, String name, String category, String unit,
                BigDecimal price, double taxRatePercent, double stock, String barcode,
                double reorderLevel) {
        this.id = id;
        this.branchId = branchId;
        this.name = name;
        this.category = category;
        this.unit = unit;
        this.price = Money.scale(price);
        this.taxRatePercent = taxRatePercent;
        this.stock = stock;
        this.barcode = barcode == null ? "" : barcode;
        this.reorderLevel = reorderLevel;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getBranchId() {
        return branchId;
    }

    public void setBranchId(String branchId) {
        this.branchId = branchId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getCategory() {
        return category;
    }

    public void setCategory(String category) {
        this.category = category;
    }

    public String getUnit() {
        return unit;
    }

    public void setUnit(String unit) {
        this.unit = unit;
    }

    public BigDecimal getPrice() {
        return price;
    }

    public void setPrice(BigDecimal price) {
        this.price = Money.scale(price);
    }

    public double getTaxRatePercent() {
        return taxRatePercent;
    }

    public void setTaxRatePercent(double taxRatePercent) {
        this.taxRatePercent = taxRatePercent;
    }

    public double getStock() {
        return stock;
    }

    public void setStock(double stock) {
        this.stock = stock;
    }

    public String getBarcode() {
        return barcode;
    }

    public void setBarcode(String barcode) {
        this.barcode = barcode == null ? "" : barcode;
    }

    public double getReorderLevel() {
        return reorderLevel;
    }

    public void setReorderLevel(double reorderLevel) {
        this.reorderLevel = reorderLevel;
    }

    @Override
    public String toString() {
        return name + " (" + id + ")";
    }
}
