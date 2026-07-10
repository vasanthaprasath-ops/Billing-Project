package grocery;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * A light structural validator for the PDFs we generate. It re-reads the file,
 * follows {@code startxref} to the cross-reference table, and confirms that
 * every recorded offset really points at the start of its object. This catches
 * byte-offset mistakes in {@link grocery.pdf.PdfDocument} without needing an
 * external PDF library.
 */
public final class PdfSelfCheck {

    private PdfSelfCheck() {
    }

    public static boolean verify(File file) {
        try {
            byte[] data = Files.readAllBytes(file.toPath());
            String text = new String(data, StandardCharsets.ISO_8859_1);

            if (!text.startsWith("%PDF-1.")) {
                System.err.println("  check: missing %PDF header");
                return false;
            }
            if (!text.contains("%%EOF")) {
                System.err.println("  check: missing %%EOF");
                return false;
            }

            int sx = text.lastIndexOf("startxref");
            if (sx < 0) {
                System.err.println("  check: missing startxref");
                return false;
            }
            String after = text.substring(sx + "startxref".length()).trim();
            int nl = indexOfWhitespace(after);
            int xrefOffset = Integer.parseInt(nl < 0 ? after : after.substring(0, nl));

            if (xrefOffset < 0 || xrefOffset >= data.length
                    || !text.startsWith("xref", xrefOffset)) {
                System.err.println("  check: startxref does not point at 'xref'");
                return false;
            }

            // Parse: xref \n 0 N \n then N entries of 20 bytes each.
            int p = xrefOffset + "xref".length();
            while (p < text.length() && (text.charAt(p) == '\r' || text.charAt(p) == '\n')) {
                p++;
            }
            int lineEnd = text.indexOf('\n', p);
            String[] hdr = text.substring(p, lineEnd).trim().split("\\s+");
            int count = Integer.parseInt(hdr[1]);
            int entriesStart = lineEnd + 1;

            // Entry 0 is the free head; objects 1..count-1 must point at "i 0 obj".
            for (int i = 1; i < count; i++) {
                int entryPos = entriesStart + i * 20;
                String entry = text.substring(entryPos, entryPos + 20);
                int objOffset = Integer.parseInt(entry.substring(0, 10));
                String expected = i + " 0 obj";
                if (!text.startsWith(expected, objOffset)) {
                    System.err.println("  check: object " + i + " offset " + objOffset
                            + " does not point at '" + expected + "'");
                    return false;
                }
            }
            return true;
        } catch (IOException | RuntimeException e) {
            System.err.println("  check: error - " + e.getMessage());
            return false;
        }
    }

    private static int indexOfWhitespace(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (Character.isWhitespace(s.charAt(i))) {
                return i;
            }
        }
        return -1;
    }
}
