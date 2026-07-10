package grocery.config;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Properties;

/**
 * Store identity printed on every invoice header. Loaded from (and saved to)
 * a simple {@code store.properties} file so the shop owner can edit their
 * name / address / GSTIN without touching the code.
 */
public class StoreConfig {

    private final File file;

    private String name;
    private String addressLine1;
    private String addressLine2;
    private String phone;
    private String email;
    private String gstin;
    private String currency;
    private String timezone;

    public StoreConfig(File file) {
        this.file = file;
        applyDefaults();
        load();
    }

    private void applyDefaults() {
        name = "FreshMart Grocery Store";
        addressLine1 = "No. 12, Market Road, T. Nagar";
        addressLine2 = "Chennai - 600017, Tamil Nadu";
        phone = "+91 98765 43210";
        email = "billing@freshmart.example";
        gstin = "33ABCDE1234F1Z5";
        currency = "Rs.";
        timezone = "Asia/Kolkata";
    }

    public void load() {
        if (!file.exists()) {
            save(); // write defaults so the owner can edit them
            return;
        }
        Properties p = new Properties();
        try (FileReader r = new FileReader(file)) {
            p.load(r);
        } catch (IOException e) {
            return;
        }
        name = p.getProperty("name", name);
        addressLine1 = p.getProperty("addressLine1", addressLine1);
        addressLine2 = p.getProperty("addressLine2", addressLine2);
        phone = p.getProperty("phone", phone);
        email = p.getProperty("email", email);
        gstin = p.getProperty("gstin", gstin);
        currency = p.getProperty("currency", currency);
        timezone = p.getProperty("timezone", timezone);
    }

    public void save() {
        Properties p = new Properties();
        p.setProperty("name", name);
        p.setProperty("addressLine1", addressLine1);
        p.setProperty("addressLine2", addressLine2);
        p.setProperty("phone", phone);
        p.setProperty("email", email);
        p.setProperty("gstin", gstin);
        p.setProperty("currency", currency);
        p.setProperty("timezone", timezone);
        File parent = file.getParentFile();
        if (parent != null) {
            parent.mkdirs();
        }
        try (FileWriter w = new FileWriter(file)) {
            p.store(w, "Grocery store details shown on invoices");
        } catch (IOException e) {
            grocery.util.Log.warn("Could not save store config: " + e.getMessage(), e);
        }
    }

    public String getName() {
        return name;
    }

    public String getAddressLine1() {
        return addressLine1;
    }

    public String getAddressLine2() {
        return addressLine2;
    }

    public String getPhone() {
        return phone;
    }

    public String getEmail() {
        return email;
    }

    public String getGstin() {
        return gstin;
    }

    public String getCurrency() {
        return currency;
    }

    public String getTimezone() {
        return timezone;
    }
}
