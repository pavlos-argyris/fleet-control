# Invoice reader build inputs

Pinned versions, download URLs, byte lengths and SHA-256 are in `android-build-support/invoice-dependencies.lock.json`. `scripts/prepare-invoice-dependencies.py` rejects a mismatch and uses `.build/invoice-deps` for an offline cache.

- Tesseract4Android 4.9.0 / Tesseract 5.5.1: https://github.com/adaptech-cz/Tesseract4Android/tree/4.9.0 — Apache 2.0. Native Leptonica, JPEG and PNG notices are included separately from that same tag.
- PDFBox Android 2.0.27.0: https://github.com/TomRoush/PdfBox-Android — Apache 2.0; Apache PDFBox includes font notices in `PDFBOX-NOTICE.txt`.
- Greek/English `tessdata_fast` models: https://github.com/tesseract-ocr/tessdata_fast — Apache 2.0; their immutable Git commit is in the lock file.
- Bouncy Castle 1.83: https://github.com/bcgit/bc-java/tree/r1rv83 — MIT notice in `BOUNCYCASTLE.txt`.
- R8/D8 8.9.35: https://r8.googlesource.com/r8 — BSD 3-Clause; build tool only, not bundled into APK.

The AAR/JAR/model binaries are reproducible build inputs rather than application source. They are excluded from Git and provided in the separate offline dependency ZIP. The complete application source remains in the source ZIP and Git commit. Existing Android toolchain notices remain under `tools/`.
