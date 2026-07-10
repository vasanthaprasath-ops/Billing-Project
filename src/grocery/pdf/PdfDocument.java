package grocery.pdf;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * A tiny, dependency-free PDF writer. It is intentionally minimal: enough to
 * place text and draw lines / filled rectangles on one or more A4 pages, which
 * is all an invoice needs. The output is a valid PDF 1.4 file that opens in any
 * reader (Adobe, Chrome, Edge, the Windows reader, etc.).
 *
 * Coordinates are in PDF points with the origin at the BOTTOM-LEFT of the page.
 * Two fonts are available: F1 = Helvetica, F2 = Helvetica-Bold.
 */
public class PdfDocument {

    public static final float A4_WIDTH = 595.28f;
    public static final float A4_HEIGHT = 841.89f;

    private final float pageWidth;
    private final float pageHeight;
    private final List<StringBuilder> pages = new ArrayList<>();
    private StringBuilder current;

    /** A standard A4 page. */
    public PdfDocument() {
        this(A4_WIDTH, A4_HEIGHT);
    }

    /** A custom page size in points (used for the narrow thermal-receipt layout). */
    public PdfDocument(float pageWidth, float pageHeight) {
        this.pageWidth = pageWidth;
        this.pageHeight = pageHeight;
        newPage();
    }

    public float width() {
        return pageWidth;
    }

    public float height() {
        return pageHeight;
    }

    /** Start a fresh blank page and make it the active one. */
    public void newPage() {
        current = new StringBuilder();
        pages.add(current);
    }

    /** Draw a string in black with its baseline at (x, y). */
    public void text(float x, float y, float size, boolean bold, String s) {
        text(x, y, size, bold, s, 0, 0, 0);
    }

    /** Draw a string in the given RGB colour (0..1) with its baseline at (x, y). */
    public void text(float x, float y, float size, boolean bold, String s,
                     float r, float g, float b) {
        String font = bold ? "/F2" : "/F1";
        current.append(num(r)).append(' ').append(num(g)).append(' ').append(num(b)).append(" rg\n")
                .append("BT\n")
                .append(font).append(' ').append(num(size)).append(" Tf\n")
                .append(num(x)).append(' ').append(num(y)).append(" Td\n")
                .append('(').append(escape(s)).append(") Tj\nET\n");
    }

    /** Draw a black stroked line from (x1,y1) to (x2,y2). */
    public void line(float x1, float y1, float x2, float y2, float strokeWidth) {
        line(x1, y1, x2, y2, strokeWidth, 0, 0, 0);
    }

    /** Draw a stroked line in the given RGB colour (0..1). */
    public void line(float x1, float y1, float x2, float y2, float strokeWidth,
                     float r, float g, float b) {
        current.append(num(r)).append(' ').append(num(g)).append(' ').append(num(b)).append(" RG\n")
                .append(num(strokeWidth)).append(" w\n")
                .append(num(x1)).append(' ').append(num(y1)).append(" m\n")
                .append(num(x2)).append(' ').append(num(y2)).append(" l\nS\n");
    }

    /** Fill a rectangle with the given grey level (0 = black, 1 = white). */
    public void fillRect(float x, float y, float w, float h, float grey) {
        fillRect(x, y, w, h, grey, grey, grey);
    }

    /** Fill a rectangle with the given RGB colour (0..1). */
    public void fillRect(float x, float y, float w, float h, float r, float g, float b) {
        current.append(num(r)).append(' ').append(num(g)).append(' ').append(num(b)).append(" rg\n")
                .append(num(x)).append(' ').append(num(y)).append(' ')
                .append(num(w)).append(' ').append(num(h)).append(" re\nf\n");
    }

    // Standard Adobe AFM advance widths (per 1000 em) for ASCII 32..126.
    private static final int[] W_HELV = {
            278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
            556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
            1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
            667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
            333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
            556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584};
    private static final int[] W_HELV_BOLD = {
            278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
            556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
            975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
            667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
            333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
            611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584};

    /** Rendered width of a string in points, using accurate Helvetica metrics. */
    public float textWidth(String s, float size, boolean bold) {
        int[] w = bold ? W_HELV_BOLD : W_HELV;
        long units = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            int idx = (c >= 32 && c <= 126) ? c - 32 : ('?' - 32);
            units += w[idx];
        }
        return (float) (units / 1000.0 * size);
    }

    public float textWidth(String s, float size) {
        return textWidth(s, size, false);
    }

    private String num(float v) {
        // Always use a dot as the decimal separator regardless of locale.
        String s = String.format(Locale.US, "%.3f", v);
        // trim trailing zeros for compactness ("12.000" -> "12")
        if (s.contains(".")) {
            s = s.replaceAll("0+$", "").replaceAll("\\.$", "");
        }
        return s;
    }

    private String escape(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' || c == '(' || c == ')') {
                b.append('\\').append(c);
            } else if (c >= 32 && c < 127) {
                b.append(c);
            } else {
                // Keep the file ASCII-clean so it renders everywhere.
                b.append('?');
            }
        }
        return b.toString();
    }

    /**
     * Serialise the whole document to PDF bytes.
     *
     * Object layout:
     *   1 = Catalog, 2 = Pages, 3 = Helvetica, 4 = Helvetica-Bold,
     *   then for each page k: page object (5+2k) and its content stream (6+2k).
     */
    public byte[] toBytes() {
        int nPages = pages.size();
        int totalObjs = 4 + nPages * 2;

        // Build every object body in object-number order.
        List<byte[]> bodies = new ArrayList<>();

        // 1: Catalog
        bodies.add(bytes("<< /Type /Catalog /Pages 2 0 R >>"));

        // 2: Pages (holds the shared MediaBox + font resources)
        StringBuilder kids = new StringBuilder();
        for (int k = 0; k < nPages; k++) {
            if (k > 0) {
                kids.append(' ');
            }
            kids.append(5 + 2 * k).append(" 0 R");
        }
        bodies.add(bytes("<< /Type /Pages /Count " + nPages
                + " /MediaBox [0 0 " + fmt(pageWidth) + " " + fmt(pageHeight) + "]"
                + " /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >>"
                + " /Kids [" + kids + "] >>"));

        // 3 & 4: the two standard fonts
        bodies.add(bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
        bodies.add(bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));

        // page + content objects
        for (int k = 0; k < nPages; k++) {
            int contentObj = 6 + 2 * k;
            bodies.add(bytes("<< /Type /Page /Parent 2 0 R /Contents " + contentObj + " 0 R >>"));

            byte[] content = bytes(pages.get(k).toString());
            ByteArrayOutputStream streamObj = new ByteArrayOutputStream();
            writeAscii(streamObj, "<< /Length " + content.length + " >>\nstream\n");
            streamObj.writeBytes(content);
            writeAscii(streamObj, "\nendstream");
            bodies.add(streamObj.toByteArray());
        }

        // Now emit the file, tracking byte offsets for the xref table.
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeAscii(out, "%PDF-1.4\n");
        out.writeBytes(new byte[]{'%', (byte) 0xE2, (byte) 0xE3, (byte) 0xCF, (byte) 0xD3, '\n'});

        int[] offsets = new int[totalObjs + 1];
        for (int i = 1; i <= totalObjs; i++) {
            offsets[i] = out.size();
            writeAscii(out, i + " 0 obj\n");
            out.writeBytes(bodies.get(i - 1));
            writeAscii(out, "\nendobj\n");
        }

        int xrefOffset = out.size();
        writeAscii(out, "xref\n0 " + (totalObjs + 1) + "\n");
        writeAscii(out, "0000000000 65535 f \n");
        for (int i = 1; i <= totalObjs; i++) {
            writeAscii(out, String.format(Locale.US, "%010d 00000 n \n", offsets[i]));
        }
        writeAscii(out, "trailer\n<< /Size " + (totalObjs + 1) + " /Root 1 0 R >>\n");
        writeAscii(out, "startxref\n" + xrefOffset + "\n%%EOF");

        return out.toByteArray();
    }

    private String fmt(float v) {
        return num(v);
    }

    private byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.ISO_8859_1);
    }

    private void writeAscii(ByteArrayOutputStream out, String s) {
        out.writeBytes(s.getBytes(StandardCharsets.ISO_8859_1));
    }
}
