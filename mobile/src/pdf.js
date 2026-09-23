/*
 * pdf.js - FreshMart PDF engine, a dependency-free JavaScript port of
 *   src/grocery/pdf/PdfDocument.java                (low-level PDF writer)
 *   src/grocery/pdf/InvoicePdfGenerator.java        (A4 tax invoice)
 *   src/grocery/pdf/ThermalReceiptPdfGenerator.java (80mm thermal receipt)
 * plus the parts of Invoice.java / InvoiceLine.java / Money.java they depend on.
 *
 * Output is byte-for-byte identical to the Java generators for the same input.
 * Plain script: no build step, no dependencies. Works in a browser / Android
 * WebView (window.FMPdf / globalThis.FMPdf) and in Node (require("./pdf.js")).
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API
 * ---------------------------------------------------------------------------
 *   FMPdf.invoicePdf(input)  -> Uint8Array   A4 tax invoice   (Java: InvoicePdfGenerator.generate)
 *   FMPdf.thermalPdf(input)  -> Uint8Array   80mm receipt     (Java: ThermalReceiptPdfGenerator.generate)
 *   FMPdf.PdfDocument                         low-level writer, same public API as PdfDocument.java
 *   FMPdf.invoiceTotals(invoice) -> object    the derived totals Invoice.java computes (all in paise)
 *   FMPdf.Money                               Money.java equivalents (see bottom of this header)
 *   FMPdf.STORE_DEFAULTS                      StoreConfig.java defaults
 *
 * ---------------------------------------------------------------------------
 * INPUT OBJECT (same for invoicePdf and thermalPdf)
 * ---------------------------------------------------------------------------
 * {
 *   store: {                        // StoreConfig (store.properties) - the header/footer identity.
 *     name:         string,         //   e.g. "FreshMart Grocery Store"
 *     addressLine1: string,
 *     addressLine2: string,
 *     phone:        string,
 *     email:        string,
 *     gstin:        string,
 *     currency:     string          //   prefix printed before every amount, e.g. "Rs."
 *   },                              //   A missing (undefined/null) field falls back to the
 *                                   //   StoreConfig default (FMPdf.STORE_DEFAULTS), exactly like
 *                                   //   a key missing from store.properties. "" prints as "".
 *                                   //   NOTE: the Java generators never read the Branch - the
 *                                   //   header always shows the store-wide identity above.
 *   invoice: {                      // Invoice - the constructor inputs (= the DB columns).
 *     invoiceNo:       string,      //   "INV-1001"
 *     dateTime:        string,      //   wall-clock LocalDateTime "yyyy-MM-ddTHH:mm:ss" (DB format;
 *                                   //   "T" or space, seconds optional). A JS Date is also accepted
 *                                   //   and read with its LOCAL getters. Printed as
 *                                   //   "dd MMM yyyy, hh:mm a" in en-US ("23 Sep 2026, 02:05 PM").
 *                                   //   (Java uses the JVM default locale here; an en_IN / en_GB
 *                                   //   JVM prints "23 Sept 2026, 02:05 pm". This port always
 *                                   //   matches a Java server running under en_US.)
 *                                   //   This is the only date in the PDF (no /CreationDate is
 *                                   //   written), so output is fully deterministic.
 *     cashierUsername: string,      //   thermal only; row hidden when "" / null
 *     customerName:    string,      //   printed as-is ("Walk-in Customer" is set by checkout, not here)
 *     customerPhone:   string,      //   "Phone" row hidden when "" / null
 *     paymentMode:     string,      //   "Cash" | "UPI" | "Card" | ... (printed as-is)
 *     discount:        money,       //   bill-level discount, rupees
 *     amountPaid:      money|null,  //   cash tendered, rupees. null/undefined/less than the grand
 *                                   //   total => treated as exactly the grand total (no change).
 *     placeOfSupplyStateCode: string, // buyer's GST state code; "" = same state as the branch
 *     branchStateCode:        string, // the selling branch's state code (branches.stateCode)
 *                                   //   interState = both non-empty AND differ (case-insensitive)
 *                                   //   -> IGST instead of CGST + SGST.
 *     lines: [{                     // InvoiceLine, in print order
 *       itemId:         string,     //   not printed
 *       name:           string,     //   clipped to 40 chars (A4) / 34 chars (thermal) + "..."
 *       unit:           string,     //   "kg", "pcs", ...
 *       price:          money,      //   unit price, rupees
 *       taxRatePercent: number,     //   GST %, e.g. 5, 12, 18, 2.5 (Java double)
 *       quantity:       number,     //   e.g. 2, 1.5, 0.25 (Java double)
 *       amount:         money,      //   line amount before tax, rupees (as stored; NOT recomputed)
 *       tax:            money       //   line GST, rupees (as stored; NOT recomputed)
 *     }]
 *   }
 * }
 *
 *   money = decimal string ("45.50", as stored in the DB TEXT columns; parsed like Money.parse:
 *           trimmed, commas removed, blank/invalid -> 0.00) or a JS number (converted like
 *           BigDecimal.valueOf(double), i.e. via its shortest decimal form, so 1.005 -> 1.01).
 *           Every amount is rounded to 2 decimals HALF_UP and then held as integer paise;
 *           no binary floating point is involved in any money arithmetic.
 *
 *   DERIVED - never read from the input, always recomputed exactly like Invoice.java's
 *   constructor (which is also what the Java server does when it reloads an invoice from the
 *   DB): subTotal = sum(line.amount); totalTax = sum(line.tax); netAmount = subTotal - discount
 *   + totalTax; grandTotal = netAmount rounded to whole rupees HALF_UP; roundOff = grandTotal -
 *   netAmount; cgst = totalTax/2 HALF_UP, sgst = totalTax - cgst (0 when inter-state);
 *   igst = totalTax (0 when intra-state); changeDue = amountPaid - grandTotal.
 *   FMPdf.invoiceTotals(invoice) returns these (as integer paise + formatted strings) so the
 *   app can store / display the same numbers.
 *
 *   Text: characters are emitted like PdfDocument.java - printable ASCII as-is, U+0080..U+00FF
 *   as WinAnsi octal escapes, a few transliterations (U+20B9 rupee -> "Rs.", en/em dash -> "-",
 *   curly quotes -> straight, NBSP -> space), everything else (Tamil, Devanagari, emoji, the
 *   real euro sign U+20AC, ...) -> "?" (one "?" per UTF-16 code unit).
 *   null/undefined strings are treated as "" (Java would print "null" or throw).
 *
 * ---------------------------------------------------------------------------
 * FMPdf.PdfDocument (mirrors PdfDocument.java; all coordinates in PDF points, origin BOTTOM-left)
 * ---------------------------------------------------------------------------
 *   new PdfDocument()                 A4 (595.28 x 841.89), first page already started
 *   new PdfDocument(width, height)    custom page size
 *   PdfDocument.A4_WIDTH, PdfDocument.A4_HEIGHT
 *   width(), height()
 *   newPage()
 *   text(x, y, size, bold, s [, r, g, b])        colour 0..1, default black
 *   line(x1, y1, x2, y2, strokeWidth [, r, g, b])
 *   fillRect(x, y, w, h, grey)  |  fillRect(x, y, w, h, r, g, b)
 *   textWidth(s, size [, bold])                  Helvetica AFM metrics, returns float32
 *   toBytes() -> Uint8Array
 *   Every numeric argument is rounded to float32 (Math.fround) on entry, like Java's float
 *   parameters. A single + - * / on float32 values followed by Math.fround equals Java float
 *   arithmetic exactly; if you chain several operations, fround each intermediate step.
 *
 * FMPdf.Money
 *   Money.parse(v)        -> integer paise  (Money.parse for strings, Money.of for numbers)
 *   Money.formatPaise(p)  -> "1234.50"      (Money.format / BigDecimal.toPlainString)
 *   Money.format(v)       -> formatPaise(parse(v)); e.g. Money.format(z.subTotal) for a double,
 *                            same as Java Money.format(BigDecimal.valueOf(z.subTotal)).
 *   Money.javaDoubleToString(d) -> Java's Double.toString(d) ("1.5", "5.0E-4", "1.0E7").
 */
(function (root) {
    "use strict";

    var fr = Math.fround;

    // =====================================================================
    // Java number formatting helpers
    // =====================================================================

    function zeros(n) {
        var s = "";
        while (s.length < n) {
            s += "0";
        }
        return s;
    }

    /** Shortest round-trip decimal digits of a positive finite double: {digits, exp} where
     *  value = 0.d1d2d3... x 10^(exp+1), i.e. d1.d2d3... x 10^exp. */
    function shortestDigits(a) {
        var s = a.toExponential(); // no argument = as many digits as needed to be unique
        var eAt = s.indexOf("e");
        var mant = s.slice(0, eAt).replace(".", "");
        return {digits: mant, exp: parseInt(s.slice(eAt + 1), 10)};
    }

    /** Java's Double.toString(double) (JDK 19+ shortest-decimal algorithm). */
    function javaDoubleToString(d) {
        if (d !== d) {
            return "NaN";
        }
        if (d === Infinity) {
            return "Infinity";
        }
        if (d === -Infinity) {
            return "-Infinity";
        }
        if (d === 0) {
            return 1 / d < 0 ? "-0.0" : "0.0";
        }
        var neg = d < 0;
        var a = neg ? -d : d;
        var sd = shortestDigits(a);
        var dg = sd.digits;
        var e = sd.exp;
        var s;
        if (a >= 1e-3 && a < 1e7) {
            if (e >= 0) {
                if (dg.length > e + 1) {
                    s = dg.slice(0, e + 1) + "." + dg.slice(e + 1);
                } else {
                    s = dg + zeros(e + 1 - dg.length) + ".0";
                }
            } else {
                s = "0." + zeros(-e - 1) + dg;
            }
        } else {
            s = dg.charAt(0) + "." + (dg.length > 1 ? dg.slice(1) : "0") + "E" + e;
        }
        return (neg ? "-" : "") + s;
    }

    /** Java's (long) cast of a double, as a decimal string. */
    function javaLongString(d) {
        if (d !== d) {
            return "0";
        }
        if (d >= 9223372036854775807) {
            return "9223372036854775807";
        }
        if (d <= -9223372036854775808) {
            return "-9223372036854775808";
        }
        var t = Math.trunc(d);
        if (t === 0) {
            return "0";
        }
        return t.toFixed(0); // exact for |t| < 1e21
    }

    /** java.util.Formatter "%.{prec}f" for a positive finite double: Java takes the shortest
     *  decimal digits of the double (as Double.toString does), rounds that digit string HALF_UP
     *  to `prec` decimals and pads with zeros. (This differs from Number.prototype.toFixed,
     *  which rounds the exact binary value - visible only for huge values like 2.4e16.) */
    function javaFixed(a, prec) {
        if (a === 0) {
            return "0." + zeros(prec);
        }
        var sd = shortestDigits(a);
        var dg = sd.digits.split("").map(Number);
        var point = sd.exp + 1;           // digits before the decimal point (may be <= 0)
        if (point < 0) {                  // normalise so the digit array starts at 10^0 or above
            dg = zeros(-point).split("").map(Number).concat(dg);
            point = 0;
        }
        var keep = point + prec;
        if (dg.length > keep) {
            var roundUp = dg[keep] >= 5;  // HALF_UP on the decimal digit string
            dg = dg.slice(0, keep);
            if (roundUp) {
                var i = keep - 1;
                while (i >= 0 && dg[i] === 9) {
                    dg[i] = 0;
                    i--;
                }
                if (i >= 0) {
                    dg[i] += 1;
                } else {
                    dg.unshift(1);
                    point += 1;
                }
            }
        }
        while (dg.length < point + prec) {
            dg.push(0);
        }
        var s = dg.join("");
        var ip = point > 0 ? s.slice(0, point).replace(/^0+(?=\d)/, "") : "0";
        return ip + "." + s.slice(point, point + prec);
    }

    /** PdfDocument.num(float): String.format(Locale.US, "%.3f", v) with trailing zeros and a
     *  trailing '.' removed. */
    function num(v) {
        v = fr(v);
        if (v !== v) {
            return "NaN";
        }
        if (v === Infinity) {
            return "Infinity";
        }
        if (v === -Infinity) {
            return "-Infinity";
        }
        var neg = v < 0 || (v === 0 && 1 / v < 0); // Java prints -0.0f as "-0"
        var s = (neg ? "-" : "") + javaFixed(neg ? -v : v, 3);
        return s.replace(/0+$/, "").replace(/\.$/, "");
    }

    function pad2(n) {
        return n < 10 ? "0" + n : String(n);
    }

    function str(v) {
        return v === undefined || v === null ? "" : String(v);
    }

    // =====================================================================
    // Money (Money.java) - integer paise, BigDecimal HALF_UP semantics
    // =====================================================================

    var DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

    /** new BigDecimal(s).setScale(2, HALF_UP) as integer paise, or null if s is not a valid
     *  BigDecimal literal. */
    function decimalToPaise(s) {
        var m = DEC_RE.exec(s);
        if (!m) {
            return null;
        }
        var ip = m[2];
        var fp = m[3] === undefined ? "" : m[3];
        if (ip === "" && fp === "") {
            return null;
        }
        var all = ip + fp;
        var exp = m[4] === undefined ? 0 : parseInt(m[4], 10);
        if (!/[1-9]/.test(all)) {
            return 0;
        }
        var point = ip.length + exp; // position of the decimal point inside `all`
        if (point < -3) {
            return 0; // below 0.001 -> rounds to 0.00
        }
        var intDigits;
        var fracDigits;
        if (point <= 0) {
            intDigits = "";
            fracDigits = zeros(-point) + all;
        } else if (point >= all.length) {
            if (point > 40) {
                throw new RangeError("Money value out of range: " + s);
            }
            intDigits = all + zeros(point - all.length);
            fracDigits = "";
        } else {
            intDigits = all.slice(0, point);
            fracDigits = all.slice(point);
        }
        var f3 = (fracDigits + "000").slice(0, 3);
        var paise = Number(intDigits.replace(/^0+/, "") || "0") * 100 + Number(f3.slice(0, 2));
        if (f3.charCodeAt(2) >= 53) { // third decimal >= 5 -> HALF_UP (away from zero)
            paise += 1;
        }
        if (!Number.isSafeInteger(paise)) {
            throw new RangeError("Money value out of range: " + s);
        }
        return m[1] === "-" && paise !== 0 ? -paise : paise;
    }

    /** Money.parse(String) for strings / Money.of(double) for numbers -> integer paise. */
    function moneyParse(v) {
        if (v === undefined || v === null) {
            return 0;                                      // Money.parse(null) -> ZERO
        }
        if (typeof v === "number") {
            if (!isFinite(v)) {
                throw new RangeError("Money value must be finite: " + v);
            }
            return decimalToPaise(javaDoubleToString(v)); // BigDecimal.valueOf(double)
        }
        // String.trim() (chars <= U+0020), then drop thousands separators.
        var cleaned = String(v).replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/,/g, "");
        if (cleaned === "") {
            return 0;
        }
        var p = decimalToPaise(cleaned);
        return p === null ? 0 : p;                         // NumberFormatException -> ZERO
    }

    /** Money.format: scale-2 BigDecimal.toPlainString(). */
    function formatPaise(p) {
        var neg = p < 0;
        var a = neg ? -p : p;
        var c = a % 100;
        return (neg ? "-" : "") + String((a - c) / 100) + "." + pad2(c);
    }

    var Money = {
        parse: moneyParse,
        formatPaise: formatPaise,
        format: function (v) {
            return formatPaise(moneyParse(v));
        },
        javaDoubleToString: javaDoubleToString
    };

    // =====================================================================
    // PdfDocument (PdfDocument.java)
    // =====================================================================

    // Standard Adobe AFM advance widths (per 1000 em) for ASCII 32..126.
    var W_HELV = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
    var W_HELV_BOLD = [
        278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
        975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
        333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
        611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

    function transliterate(c) {
        switch (c) {
            case 0x20B9: return "Rs.";  // rupee sign
            case 0x2013:                // en dash
            case 0x2014: return "-";    // em dash
            case 0x2018:                // curly single quotes
            case 0x2019: return "'";
            case 0x201C:                // curly double quotes
            case 0x201D: return "\"";
            case 0x00A0: return " ";    // non-breaking space
            default: return null;
        }
    }

    function escapedChar(c) {
        if (c === 0x5C || c === 0x28 || c === 0x29) {   // \ ( )
            return "\\" + String.fromCharCode(c);
        }
        if (c >= 32 && c < 127) {
            return String.fromCharCode(c);
        }
        if (c >= 0x80 && c <= 0xFF) {                   // Latin-1 -> 3-digit octal escape
            return "\\" + ((c >> 6) & 7) + ((c >> 3) & 7) + (c & 7);
        }
        return "?";
    }

    function escapePdf(s) {
        var out = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            var rep = transliterate(c);
            if (rep !== null) {
                for (var j = 0; j < rep.length; j++) {
                    out += escapedChar(rep.charCodeAt(j));
                }
            } else {
                out += escapedChar(c);
            }
        }
        return out;
    }

    function pad10(n) {
        var s = String(n);
        return s.length >= 10 ? s : zeros(10 - s.length) + s;
    }

    class PdfDocument {
        constructor(pageWidth, pageHeight) {
            if (pageWidth === undefined) {
                pageWidth = PdfDocument.A4_WIDTH;
                pageHeight = PdfDocument.A4_HEIGHT;
            }
            this._pageWidth = fr(pageWidth);
            this._pageHeight = fr(pageHeight);
            this._pages = [];
            this._current = null;
            this.newPage();
        }

        width() {
            return this._pageWidth;
        }

        height() {
            return this._pageHeight;
        }

        /** Start a fresh blank page and make it the active one. */
        newPage() {
            this._current = [];
            this._pages.push(this._current);
        }

        /** Draw a string (default black) with its baseline at (x, y). */
        text(x, y, size, bold, s, r, g, b) {
            if (r === undefined) {
                r = 0;
                g = 0;
                b = 0;
            }
            var font = bold ? "/F2" : "/F1";
            this._current.push(num(r) + " " + num(g) + " " + num(b) + " rg\n"
                + "BT\n"
                + font + " " + num(size) + " Tf\n"
                + num(x) + " " + num(y) + " Td\n"
                + "(" + escapePdf(str(s)) + ") Tj\nET\n");
        }

        /** Draw a stroked line (default black) from (x1,y1) to (x2,y2). */
        line(x1, y1, x2, y2, strokeWidth, r, g, b) {
            if (r === undefined) {
                r = 0;
                g = 0;
                b = 0;
            }
            this._current.push(num(r) + " " + num(g) + " " + num(b) + " RG\n"
                + num(strokeWidth) + " w\n"
                + num(x1) + " " + num(y1) + " m\n"
                + num(x2) + " " + num(y2) + " l\nS\n");
        }

        /** fillRect(x, y, w, h, grey) or fillRect(x, y, w, h, r, g, b). */
        fillRect(x, y, w, h, r, g, b) {
            if (g === undefined) {
                g = r;
                b = r;
            }
            this._current.push(num(r) + " " + num(g) + " " + num(b) + " rg\n"
                + num(x) + " " + num(y) + " "
                + num(w) + " " + num(h) + " re\nf\n");
        }

        /** Rendered width in points (float32). Chars outside ASCII 32..126 use the '?' width. */
        textWidth(s, size, bold) {
            s = str(s);
            var w = bold ? W_HELV_BOLD : W_HELV;
            var units = 0;
            for (var i = 0; i < s.length; i++) {
                var c = s.charCodeAt(i);
                units += w[(c >= 32 && c <= 126) ? c - 32 : 31];
            }
            return fr(units / 1000.0 * fr(size));
        }

        /** Serialise the whole document to PDF bytes (object layout identical to Java). */
        toBytes() {
            var nPages = this._pages.length;
            var totalObjs = 4 + nPages * 2;
            var bodies = [];

            bodies.push("<< /Type /Catalog /Pages 2 0 R >>");
            var kids = [];
            for (var k = 0; k < nPages; k++) {
                kids.push((5 + 2 * k) + " 0 R");
            }
            bodies.push("<< /Type /Pages /Count " + nPages
                + " /MediaBox [0 0 " + num(this._pageWidth) + " " + num(this._pageHeight) + "]"
                + " /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >>"
                + " /Kids [" + kids.join(" ") + "] >>");
            bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
            bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
            for (k = 0; k < nPages; k++) {
                bodies.push("<< /Type /Page /Parent 2 0 R /Contents " + (6 + 2 * k) + " 0 R >>");
                var content = this._pages[k].join("");
                bodies.push("<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream");
            }

            var out = "%PDF-1.4\n%âãÏÓ\n";
            var offsets = [0];
            for (var i = 1; i <= totalObjs; i++) {
                offsets.push(out.length);
                out += i + " 0 obj\n" + bodies[i - 1] + "\nendobj\n";
            }
            var xrefOffset = out.length;
            out += "xref\n0 " + (totalObjs + 1) + "\n";
            out += "0000000000 65535 f \n";
            for (i = 1; i <= totalObjs; i++) {
                out += pad10(offsets[i]) + " 00000 n \n";
            }
            out += "trailer\n<< /Size " + (totalObjs + 1) + " /Root 1 0 R >>\n";
            out += "startxref\n" + xrefOffset + "\n%%EOF";

            // ISO-8859-1 encode (unmappable -> '?', as Java's String.getBytes does). Everything
            // written above is ASCII or Latin-1, so every char is exactly one byte.
            var bytes = new Uint8Array(out.length);
            for (i = 0; i < out.length; i++) {
                var c = out.charCodeAt(i);
                bytes[i] = c > 0xFF ? 0x3F : c;
            }
            return bytes;
        }
    }

    PdfDocument.A4_WIDTH = fr(595.28);
    PdfDocument.A4_HEIGHT = fr(841.89);

    // =====================================================================
    // Model: Invoice / InvoiceLine / StoreConfig
    // =====================================================================

    var STORE_DEFAULTS = {
        name: "FreshMart Grocery Store",
        addressLine1: "No. 12, Market Road, T. Nagar",
        addressLine2: "Chennai - 600017, Tamil Nadu",
        phone: "+91 98765 43210",
        email: "billing@freshmart.example",
        gstin: "33ABCDE1234F1Z5",
        currency: "Rs."
    };

    function normStore(s) {
        s = s || {};
        var out = {};
        for (var k in STORE_DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(STORE_DEFAULTS, k)) {
                out[k] = s[k] === undefined || s[k] === null ? STORE_DEFAULTS[k] : String(s[k]);
            }
        }
        return out;
    }

    function dbl(v, field) {
        if (typeof v === "number") {
            return v;
        }
        if (v === undefined || v === null || v === "") {
            return 0;
        }
        var n = Number(String(v).trim());
        if (n !== n && String(v).trim() !== "NaN") {
            throw new TypeError("Invalid number for " + field + ": " + v);
        }
        return n;
    }

    var DT_RE = /^([+-]?\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;

    function parseDateTime(v) {
        if (v instanceof Date) {
            if (isNaN(v.getTime())) {
                throw new TypeError("Invalid invoice dateTime");
            }
            return {year: v.getFullYear(), month: v.getMonth() + 1, day: v.getDate(),
                hour: v.getHours(), minute: v.getMinutes()};
        }
        var m = DT_RE.exec(str(v).trim());
        if (!m) {
            throw new TypeError("Invalid invoice dateTime (expected yyyy-MM-ddTHH:mm:ss): " + v);
        }
        var dt = {year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10),
            hour: parseInt(m[4], 10), minute: parseInt(m[5], 10)};
        if (dt.month < 1 || dt.month > 12 || dt.day < 1 || dt.day > 31 || dt.hour > 23 || dt.minute > 59
            || (m[6] !== undefined && parseInt(m[6], 10) > 59)) {
            throw new TypeError("Invalid invoice dateTime: " + v);
        }
        return dt;
    }

    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    /** DateTimeFormatter.ofPattern("dd MMM yyyy, hh:mm a") in Locale.US. */
    function formatDateTime(dt) {
        var yoe = dt.year >= 1 ? dt.year : 1 - dt.year; // year-of-era
        var ys = String(yoe);
        ys = yoe > 9999 ? "+" + ys : zeros(4 - ys.length) + ys;
        var h12 = dt.hour % 12 === 0 ? 12 : dt.hour % 12;
        return pad2(dt.day) + " " + MONTHS[dt.month - 1] + " " + ys + ", "
            + pad2(h12) + ":" + pad2(dt.minute) + " " + (dt.hour < 12 ? "AM" : "PM");
    }

    /** Java String.equalsIgnoreCase (per-UTF-16-unit upper/lower comparison). */
    function equalsIgnoreCase(a, b) {
        if (a.length !== b.length) {
            return false;
        }
        for (var i = 0; i < a.length; i++) {
            var c1 = a.charAt(i);
            var c2 = b.charAt(i);
            if (c1 === c2) {
                continue;
            }
            var u1 = c1.toUpperCase();
            var u2 = c2.toUpperCase();
            if (u1.length !== 1) {
                u1 = c1;
            }
            if (u2.length !== 1) {
                u2 = c2;
            }
            if (u1 === u2) {
                continue;
            }
            var l1 = u1.toLowerCase();
            var l2 = u2.toLowerCase();
            if ((l1.length === 1 ? l1 : u1) === (l2.length === 1 ? l2 : u2)) {
                continue;
            }
            return false;
        }
        return true;
    }

    /** BigDecimal.setScale(0, HALF_UP) on integer paise -> whole rupees (still in paise). */
    function roundToRupee(p) {
        var a = p < 0 ? -p : p;
        var r = Math.floor((a + 50) / 100) * 100;
        return p < 0 && r !== 0 ? -r : r;
    }

    /** Money.scale(x.divide(2)) on integer paise (HALF_UP, away from zero). */
    function halfUpHalf(p) {
        var a = p < 0 ? -p : p;
        var h = Math.floor((a + 1) / 2);
        return p < 0 && h !== 0 ? -h : h;
    }

    /** Normalises the raw input invoice and derives every total exactly like Invoice.java. */
    function buildInvoice(raw) {
        raw = raw || {};
        var lines = (raw.lines || []).map(function (l, i) {
            l = l || {};
            return {
                itemId: str(l.itemId),
                name: str(l.name),
                unit: str(l.unit),
                price: moneyParse(l.price),
                taxRatePercent: dbl(l.taxRatePercent, "lines[" + i + "].taxRatePercent"),
                quantity: dbl(l.quantity, "lines[" + i + "].quantity"),
                amount: moneyParse(l.amount),
                tax: moneyParse(l.tax)
            };
        });
        var sub = 0;
        var tax = 0;
        for (var i = 0; i < lines.length; i++) {
            sub += lines[i].amount;
            tax += lines[i].tax;
        }
        var discount = moneyParse(raw.discount);
        var net = sub - discount + tax;
        var grand = roundToRupee(net);
        var paidIn = raw.amountPaid === undefined || raw.amountPaid === null ? null : moneyParse(raw.amountPaid);
        var paid = paidIn === null || paidIn < grand ? grand : paidIn;
        var pos = str(raw.placeOfSupplyStateCode);
        var bs = str(raw.branchStateCode);
        var inter = pos !== "" && bs !== "" && !equalsIgnoreCase(pos, bs);
        var cgst = inter ? 0 : halfUpHalf(tax);
        return {
            invoiceNo: str(raw.invoiceNo),
            dateTime: raw.dateTime === undefined ? null : parseDateTime(raw.dateTime),
            cashierUsername: str(raw.cashierUsername),
            customerName: str(raw.customerName),
            customerPhone: str(raw.customerPhone),
            paymentMode: str(raw.paymentMode),
            placeOfSupplyStateCode: pos,
            lines: lines,
            subTotal: sub,
            discount: discount,
            totalTax: tax,
            netAmount: net,
            roundOff: grand - net,
            grandTotal: grand,
            amountPaid: paid,
            changeDue: paid - grand,
            interState: inter,
            cgst: cgst,
            sgst: inter ? 0 : tax - cgst,
            igst: inter ? tax : 0
        };
    }

    /** Public: the totals Invoice.java would compute for this raw invoice (paise + strings). */
    function invoiceTotals(rawInvoice) {
        var inv = buildInvoice(Object.assign({}, rawInvoice, {dateTime: undefined}));
        var keys = ["subTotal", "discount", "totalTax", "netAmount", "roundOff", "grandTotal",
            "amountPaid", "changeDue", "cgst", "sgst", "igst"];
        var out = {interState: inv.interState, paise: {}, formatted: {}};
        keys.forEach(function (k) {
            out.paise[k] = inv[k];
            out.formatted[k] = formatPaise(inv[k]);
        });
        return out;
    }

    function requireDate(inv) {
        if (!inv.dateTime) {
            throw new TypeError("invoice.dateTime is required");
        }
        return formatDateTime(inv.dateTime);
    }

    /** InvoicePdfGenerator.qty / ThermalReceiptPdfGenerator.qty */
    function qty(q) {
        if (q === Math.floor(q)) {
            return javaLongString(q);
        }
        return javaDoubleToString(q);
    }

    function trimPct(p) {
        if (p === Math.floor(p)) {
            return javaLongString(p) + "%";
        }
        return javaDoubleToString(p) + "%";
    }

    function clip(s, max) {
        if (s.length <= max) {
            return s;
        }
        return s.substring(0, max - 3) + "...";
    }

    // amount in words (Indian numbering)
    var ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
        "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
        "Seventeen", "Eighteen", "Nineteen"];
    var TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

    function twoDigits(n) {
        if (n < 20) {
            return ONES[n];
        }
        return TENS[Math.trunc(n / 10)] + (n % 10 !== 0 ? " " + ONES[n % 10] : "");
    }

    function words(n) {
        if (n === 0) {
            return "Zero";
        }
        var s = "";
        var crore = Math.trunc(n / 10000000);
        n %= 10000000;
        var lakh = Math.trunc(n / 100000);
        n %= 100000;
        var thousand = Math.trunc(n / 1000);
        n %= 1000;
        var hundred = Math.trunc(n / 100);
        n %= 100;
        if (crore > 0) {
            s += words(crore) + " Crore ";
        }
        if (lakh > 0) {
            s += twoDigits(lakh) + " Lakh ";
        }
        if (thousand > 0) {
            s += twoDigits(thousand) + " Thousand ";
        }
        if (hundred > 0) {
            s += ONES[hundred] + " Hundred ";
        }
        if (n > 0) {
            s += twoDigits(n);
        }
        return s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
    }

    function amountInWords(paise) {
        var rupees = Math.trunc(paise / 100);   // BigDecimal.longValue()
        var p = paise - rupees * 100;
        var s = "Rupees " + words(rupees);
        if (p > 0) {
            s += " and " + words(p) + " Paise";
        }
        return s + " Only";
    }

    // =====================================================================
    // InvoicePdfGenerator (A4)
    // =====================================================================

    function rgb(r, g, b) {
        return [fr(r), fr(g), fr(b)];
    }

    var GREEN = rgb(0.086, 0.639, 0.290);
    var GREEN_DARK = rgb(0.078, 0.325, 0.176);
    var LIGHT_GREEN = rgb(0.886, 0.969, 0.910);
    var WHITE = rgb(1, 1, 1);
    var WHITE_SOFT = rgb(0.85, 0.95, 0.88);
    var DARK = rgb(0.06, 0.09, 0.16);
    var MUTED = rgb(0.39, 0.45, 0.54);
    var ZEBRA = rgb(0.965, 0.973, 0.969);
    var LINE = rgb(0.85, 0.87, 0.86);

    var A4_M = 40;
    var ROW_H = 19;
    var COL_NO = 48;
    var COL_ITEM = 72;
    var COL_QTY_R = 332;
    var COL_UNIT = 344;
    var COL_RATE_R = 432;
    var COL_GST_R = 486;
    var COL_AMT_R = 551;

    // drawing helpers (top-based coordinates); every argument is a Java float
    function t(d, x, yTop, size, bold, s, c) {
        d.text(x, fr(d.height() - fr(yTop)), size, bold, s, c[0], c[1], c[2]);
    }

    function tr(d, xRight, yTop, size, bold, s, c) {
        var w = d.textWidth(s, size, bold);
        d.text(fr(fr(xRight) - w), fr(d.height() - fr(yTop)), size, bold, s, c[0], c[1], c[2]);
    }

    function tcenter(d, yTop, size, bold, s, c) {
        var w = d.textWidth(s, size, bold);
        d.text(fr(fr(d.width() - w) / 2), fr(d.height() - fr(yTop)), size, bold, s, c[0], c[1], c[2]);
    }

    function rect(d, xLeft, yTopEdge, w, h, c) {
        d.fillRect(xLeft, fr(d.height() - fr(fr(yTopEdge) + fr(h))), w, h, c[0], c[1], c[2]);
    }

    function hline(d, x1, x2, yTop, width, c) {
        var y = fr(d.height() - fr(yTop));
        d.line(x1, y, x2, y, width, c[0], c[1], c[2]);
    }

    function drawHeaderBand(d, store, inv) {
        var right = fr(d.width() - A4_M);
        rect(d, 0, 0, d.width(), 104, GREEN);

        t(d, A4_M, 40, 22, true, store.name, WHITE);
        t(d, A4_M, 58, 9, false, store.addressLine1, WHITE_SOFT);
        t(d, A4_M, 70, 9, false, store.addressLine2, WHITE_SOFT);
        t(d, A4_M, 82, 8.5, false, "Ph: " + store.phone + "    " + store.email, WHITE_SOFT);
        t(d, A4_M, 94, 8.5, false, "GSTIN: " + store.gstin, WHITE_SOFT);

        tr(d, right, 44, 26, true, "INVOICE", WHITE);
        tr(d, right, 64, 11, true, "No: " + inv.invoiceNo, WHITE);
        tr(d, right, 79, 9.5, false, requireDate(inv), WHITE_SOFT);
    }

    function drawContinuationHeader(d, store, inv) {
        var right = fr(d.width() - A4_M);
        rect(d, 0, 0, d.width(), 42, GREEN);
        t(d, A4_M, 27, 15, true, store.name, WHITE);
        tr(d, right, 27, 12, true, "Invoice " + inv.invoiceNo + " (contd.)", WHITE);
        return 64;
    }

    function drawParties(d, inv) {
        var right = fr(d.width() - A4_M);
        var y = 132;

        t(d, A4_M, y, 9, true, "BILL TO", MUTED);
        tr(d, right, y, 9, true, "PAYMENT MODE", MUTED);
        y = fr(y + 16);
        t(d, A4_M, y, 12.5, true, inv.customerName, DARK);
        tr(d, right, y, 12.5, true, inv.paymentMode, GREEN_DARK);
        y = fr(y + 14);
        if (inv.customerPhone !== "") {
            t(d, A4_M, y, 9.5, false, "Phone: " + inv.customerPhone, MUTED);
        }
        y = fr(y + 10);

        hline(d, A4_M, right, y, 0.6, LINE);
        y = fr(y + 22);

        t(d, A4_M, y, 11, true, "Dear " + inv.customerName + ",", DARK);
        y = fr(y + 15);
        t(d, A4_M, y, 9.5, false,
            "Thank you for shopping with us! Here is a summary of your purchase.", MUTED);
        y = fr(y + 18);
        return y;
    }

    function drawTableHeader(d, yTop) {
        yTop = fr(yTop);
        var right = fr(d.width() - A4_M);
        rect(d, A4_M, yTop, fr(right - A4_M), 22, GREEN_DARK);
        var b = fr(yTop + 15);
        t(d, COL_NO, b, 9, true, "#", WHITE);
        t(d, COL_ITEM, b, 9, true, "ITEM", WHITE);
        tr(d, COL_QTY_R, b, 9, true, "QTY", WHITE);
        t(d, COL_UNIT, b, 9, true, "UNIT", WHITE);
        tr(d, COL_RATE_R, b, 9, true, "RATE", WHITE);
        tr(d, COL_GST_R, b, 9, true, "GST%", WHITE);
        tr(d, COL_AMT_R, b, 9, true, "AMOUNT", WHITE);
        return fr(yTop + 24);
    }

    function drawRow(d, yTop, sno, line, zebra) {
        yTop = fr(yTop);
        var right = fr(d.width() - A4_M);
        if (zebra) {
            rect(d, A4_M, yTop, fr(right - A4_M), ROW_H, ZEBRA);
        }
        var b = fr(yTop + 13);
        t(d, COL_NO, b, 9, false, String(sno), DARK);
        t(d, COL_ITEM, b, 9, false, clip(line.name, 40), DARK);
        tr(d, COL_QTY_R, b, 9, false, qty(line.quantity), DARK);
        t(d, COL_UNIT, b, 9, false, line.unit, MUTED);
        tr(d, COL_RATE_R, b, 9, false, formatPaise(line.price), DARK);
        tr(d, COL_GST_R, b, 9, false, trimPct(line.taxRatePercent), MUTED);
        tr(d, COL_AMT_R, b, 9, false, formatPaise(line.amount), DARK);
    }

    function totalLine(d, labelX, valueR, yTop, label, value) {
        var b = fr(fr(yTop) + 11);
        t(d, labelX, b, 10, false, label, MUTED);
        tr(d, fr(fr(valueR) - 6), b, 10, false, value, DARK);
    }

    function drawTotals(d, store, yTop, inv) {
        var right = fr(d.width() - A4_M);
        var cur = store.currency + " ";
        var labelX = 360;
        var y = fr(yTop);

        totalLine(d, labelX, right, y, "Sub Total", cur + formatPaise(inv.subTotal));
        y = fr(y + 16);
        if (inv.discount > 0) {
            totalLine(d, labelX, right, y, "Discount", "- " + cur + formatPaise(inv.discount));
            y = fr(y + 16);
        }
        if (inv.totalTax > 0) {
            if (inv.interState) {
                totalLine(d, labelX, right, y, "IGST", cur + formatPaise(inv.igst));
                y = fr(y + 16);
            } else {
                totalLine(d, labelX, right, y, "CGST", cur + formatPaise(inv.cgst));
                y = fr(y + 16);
                totalLine(d, labelX, right, y, "SGST", cur + formatPaise(inv.sgst));
                y = fr(y + 16);
            }
        }
        if (inv.roundOff !== 0) {
            var sign = inv.roundOff > 0 ? "+ " : "- ";
            totalLine(d, labelX, right, y, "Round Off", sign + cur + formatPaise(Math.abs(inv.roundOff)));
            y = fr(y + 16);
        }

        // highlighted grand total bar
        y = fr(y + 2);
        var barX = fr(labelX - 8);
        rect(d, barX, y, fr(right - barX), 26, GREEN);
        t(d, labelX, fr(y + 17), 12, true, "GRAND TOTAL", WHITE);
        tr(d, fr(right - 6), fr(y + 17), 13, true, cur + formatPaise(inv.grandTotal), WHITE);
        y = fr(y + 36);

        // amount in words (full width)
        t(d, A4_M, y, 9, true, "Amount in words:", MUTED);
        y = fr(y + 13);
        t(d, A4_M, y, 9.5, false, amountInWords(inv.grandTotal), DARK);
        y = fr(y + 16);

        if (inv.discount > 0) {
            t(d, A4_M, y, 9.5, true,
                "You saved " + cur + formatPaise(inv.discount) + " on this purchase!", GREEN_DARK);
        }
    }

    function drawGreetingFooter(d, store) {
        var H = d.height();
        tcenter(d, fr(H - 96), 8, false,
            "This is a computer-generated invoice and does not require a signature.", MUTED);
        rect(d, 0, fr(H - 80), d.width(), 80, LIGHT_GREEN);
        tcenter(d, fr(H - 53), 13, true, "Thank you for shopping with us!", GREEN_DARK);
        tcenter(d, fr(H - 37), 9.5, false,
            "We truly appreciate your visit and hope to see you again soon.", MUTED);
        tcenter(d, fr(H - 22), 8, false,
            store.name + "   |   " + store.phone + "   |   " + store.email, MUTED);
    }

    function invoicePdf(input) {
        input = input || {};
        var store = normStore(input.store);
        var inv = buildInvoice(input.invoice);

        var d = new PdfDocument();
        drawHeaderBand(d, store, inv);
        var y = drawParties(d, inv);
        y = drawTableHeader(d, y);

        var lines = inv.lines;
        for (var i = 0; i < lines.length; i++) {
            if (fr(y + ROW_H) > fr(d.height() - 250)) {  // keep room for totals + footer
                d.newPage();
                y = drawContinuationHeader(d, store, inv);
                y = drawTableHeader(d, y);
            }
            drawRow(d, y, i + 1, lines[i], i % 2 === 1);
            y = fr(y + ROW_H);
        }

        hline(d, A4_M, fr(d.width() - A4_M), y, 0.8, LINE);
        y = fr(y + 18);
        drawTotals(d, store, y, inv);
        drawGreetingFooter(d, store);
        return d.toBytes();
    }

    // =====================================================================
    // ThermalReceiptPdfGenerator (80mm roll, single page sized to content)
    // =====================================================================

    var TH_PAGE_WIDTH = 226;
    var TH_M = 10;
    var TH_RIGHT = fr(TH_PAGE_WIDTH - TH_M);
    var TH_LH = 11;
    var TH_BOTTOM_PADDING = 8;

    // null-safe drawing helpers (d === null => measuring pass), all black
    function tt(d, x, yTop, size, bold, s) {
        if (d === null) {
            return;
        }
        d.text(x, fr(d.height() - fr(yTop)), size, bold, s, 0, 0, 0);
    }

    function ttr(d, xRight, yTop, size, bold, s) {
        if (d === null) {
            return;
        }
        var w = d.textWidth(s, size, bold);
        d.text(fr(fr(xRight) - w), fr(d.height() - fr(yTop)), size, bold, s, 0, 0, 0);
    }

    function ttc(d, yTop, size, bold, s) {
        if (d === null) {
            return;
        }
        var w = d.textWidth(s, size, bold);
        d.text(fr(fr(TH_PAGE_WIDTH - w) / 2), fr(d.height() - fr(yTop)), size, bold, s, 0, 0, 0);
    }

    function thr(d, yTop) {
        if (d === null) {
            return;
        }
        var y = fr(d.height() - fr(yTop));
        d.line(TH_M, y, fr(TH_PAGE_WIDTH - TH_M), y, 0.6, 0, 0, 0);
    }

    function labelValue(d, yTop, size, bold, label, value) {
        tt(d, TH_M, yTop, size, bold, label);
        ttr(d, TH_RIGHT, yTop, size, bold, value);
    }

    /** Draws the receipt into d if non-null; always returns the total height used. */
    function thermalLayout(d, store, inv) {
        var y = TH_M;

        ttc(d, y, 11, true, store.name);
        y = fr(y + 13);
        ttc(d, y, 7.5, false, store.addressLine1);
        y = fr(y + 9);
        ttc(d, y, 7.5, false, store.addressLine2);
        y = fr(y + 9);
        ttc(d, y, 7.5, false, "Ph: " + store.phone);
        y = fr(y + 9);
        ttc(d, y, 7.5, false, "GSTIN: " + store.gstin);
        y = fr(y + 10);
        thr(d, y);
        y = fr(y + 13);

        ttc(d, y, 9.5, true, "TAX INVOICE");
        y = fr(y + 14);
        labelValue(d, y, 8, false, "Invoice No", inv.invoiceNo);
        y = fr(y + TH_LH);
        labelValue(d, y, 8, false, "Date", requireDate(inv));
        y = fr(y + TH_LH);
        if (inv.cashierUsername !== "") {
            labelValue(d, y, 8, false, "Cashier", inv.cashierUsername);
            y = fr(y + TH_LH);
        }
        labelValue(d, y, 8, false, "Customer", inv.customerName);
        y = fr(y + TH_LH);
        if (inv.customerPhone !== "") {
            labelValue(d, y, 8, false, "Phone", inv.customerPhone);
            y = fr(y + TH_LH);
        }
        y = fr(y + 2);
        thr(d, y);
        y = fr(y + 12);

        var lines = inv.lines;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            tt(d, TH_M, y, 8.5, true, clip(line.name, 34));
            y = fr(y + TH_LH);
            var left = qty(line.quantity) + " " + line.unit + " x " + formatPaise(line.price);
            labelValue(d, y, 8, false, left, formatPaise(line.amount));
            y = fr(y + TH_LH);
        }
        y = fr(y + 1);
        thr(d, y);
        y = fr(y + 13);

        var cur = store.currency + " ";
        labelValue(d, y, 8.5, false, "Sub Total", cur + formatPaise(inv.subTotal));
        y = fr(y + TH_LH);
        if (inv.discount > 0) {
            labelValue(d, y, 8.5, false, "Discount", "-" + cur + formatPaise(inv.discount));
            y = fr(y + TH_LH);
        }
        if (inv.totalTax > 0) {
            if (inv.interState) {
                labelValue(d, y, 8.5, false, "IGST", cur + formatPaise(inv.igst));
                y = fr(y + TH_LH);
            } else {
                labelValue(d, y, 8.5, false, "CGST", cur + formatPaise(inv.cgst));
                y = fr(y + TH_LH);
                labelValue(d, y, 8.5, false, "SGST", cur + formatPaise(inv.sgst));
                y = fr(y + TH_LH);
            }
        }
        if (inv.roundOff !== 0) {
            var sign = inv.roundOff > 0 ? "+" : "-";
            labelValue(d, y, 8.5, false, "Round Off", sign + cur + formatPaise(Math.abs(inv.roundOff)));
            y = fr(y + TH_LH);
        }
        y = fr(y + 4);
        thr(d, y);
        y = fr(y + 16);
        labelValue(d, y, 12, true, "GRAND TOTAL", cur + formatPaise(inv.grandTotal));
        y = fr(y + 15);
        thr(d, y);
        y = fr(y + 13);

        labelValue(d, y, 8, false, "Payment Mode", inv.paymentMode);
        y = fr(y + TH_LH);
        // Cash tendered / change: only when the customer gave more than the total.
        if (inv.changeDue > 0) {
            labelValue(d, y, 8, false, "Cash Tendered", cur + formatPaise(inv.amountPaid));
            y = fr(y + TH_LH);
            labelValue(d, y, 8.5, true, "Change", cur + formatPaise(inv.changeDue));
            y = fr(y + TH_LH);
        }
        y = fr(y + 7);
        ttc(d, y, 9.5, true, "Thank you for shopping with us!");
        y = fr(y + 12);
        ttc(d, y, 7.5, false, store.phone + "   " + store.email);
        y = fr(y + 10);
        y = fr(y + TH_M);

        return y;
    }

    function thermalPdf(input) {
        input = input || {};
        var store = normStore(input.store);
        var inv = buildInvoice(input.invoice);
        requireDate(inv);
        var contentHeight = thermalLayout(null, store, inv);
        var d = new PdfDocument(TH_PAGE_WIDTH, fr(contentHeight + TH_BOTTOM_PADDING));
        thermalLayout(d, store, inv);
        return d.toBytes();
    }

    // =====================================================================
    // exports
    // =====================================================================

    var FMPdf = {
        invoicePdf: invoicePdf,
        thermalPdf: thermalPdf,
        invoiceTotals: invoiceTotals,
        PdfDocument: PdfDocument,
        Money: Money,
        STORE_DEFAULTS: Object.freeze(Object.assign({}, STORE_DEFAULTS)),
        // Private helpers, exposed only so the Java-vs-JS differential tests can call them.
        _internal: {
            num: num, escape: escapePdf, qty: qty, trimPct: trimPct, clip: clip,
            formatDateTime: formatDateTime, parseDateTime: parseDateTime,
            amountInWords: amountInWords, buildInvoice: buildInvoice
        }
    };

    root.FMPdf = FMPdf;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = FMPdf;
    }
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
