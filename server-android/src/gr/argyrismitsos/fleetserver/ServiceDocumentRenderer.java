package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.FleetLayoutResultCallback;
import android.print.FleetWriteResultCallback;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONTokener;

import java.io.File;
import java.io.IOException;
import java.net.URL;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Renders the dynamic invoice page using Android WebView's print pipeline.
 * The print adapter applies the page's @media print rules, which is the same
 * path used by the Impact page's visible "Εκτύπωση" action.
 */
public final class ServiceDocumentRenderer {
    private static final long RENDER_TIMEOUT_MS = 50000L;
    private static final int READY_ATTEMPTS = 50;

    private ServiceDocumentRenderer() {
    }

    public static File renderToPdf(final Context context, final String pageUrl, final String documentName) throws Exception {
        return renderToPdfWithText(context, pageUrl, documentName).output;
    }

    public static RenderedDocument renderToPdfWithText(final Context context, final String pageUrl, final String documentName) throws Exception {
        validateUrl(pageUrl);
        final CountDownLatch finished = new CountDownLatch(1);
        final RenderState state = new RenderState(context, pageUrl, documentName, finished);
        final Handler handler = new Handler(Looper.getMainLooper());
        state.handler = handler;
        handler.post(new Runnable() {
            @Override
            public void run() {
                startOnMain(state);
            }
        });
        if (!finished.await(RENDER_TIMEOUT_MS + 5000L, TimeUnit.MILLISECONDS)) {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    finishFailure(state, new IOException("Η δημιουργία PDF του τιμολογίου ξεπέρασε το χρονικό όριο."));
                }
            });
            throw new IOException("Η δημιουργία PDF του τιμολογίου ξεπέρασε το χρονικό όριο.");
        }
        if (state.error != null) throw new IOException(state.error.getMessage(), state.error);
        if (state.output == null || !state.output.exists() || state.output.length() < 4) {
            throw new IOException("Ο Server δεν δημιούργησε PDF από τη σελίδα του QR.");
        }
        return new RenderedDocument(state.output, state.pageText);
    }

    private static void validateUrl(String value) throws Exception {
        URL url = new URL(value);
        String protocol = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase();
        if (!"https".equals(protocol) || url.getHost() == null || url.getHost().length() == 0) {
            throw new IOException("Το URL του QR δεν είναι ασφαλές.");
        }
    }

    private static void startOnMain(final RenderState state) {
        if (state.finished.get()) return;
        try {
            final WebView webView = new WebView(state.context);
            state.webView = webView;
            webView.setBackgroundColor(0xffffffff);
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowContentAccess(true);
            settings.setAllowFileAccess(false);
            settings.setLoadWithOverviewMode(true);
            settings.setUseWideViewPort(true);
            settings.setTextZoom(100);
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    waitForInvoice(state, 0);
                }
            });
            state.timeout = new Runnable() {
                @Override
                public void run() {
                    finishFailure(state, new IOException("Η ηλεκτρονική σελίδα του τιμολογίου δεν ολοκλήρωσε τη φόρτωση."));
                }
            };
            state.handler.postDelayed(state.timeout, RENDER_TIMEOUT_MS);
            webView.measure(
                    android.view.View.MeasureSpec.makeMeasureSpec(1600, android.view.View.MeasureSpec.EXACTLY),
                    android.view.View.MeasureSpec.makeMeasureSpec(2200, android.view.View.MeasureSpec.AT_MOST));
            webView.layout(0, 0, 1600, Math.max(1200, webView.getMeasuredHeight()));
            webView.loadUrl(state.pageUrl);
        } catch (Throwable error) {
            finishFailure(state, error);
        }
    }

    private static void waitForInvoice(final RenderState state, final int attempt) {
        if (state.finished.get() || state.webView == null) return;
        state.webView.evaluateJavascript(
                "(function(){if(document.querySelector('.invoice'))return 'invoice';var b=document.body;return b&&b.innerText&&b.innerText.length>120?'body':'waiting';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (state.finished.get()) return;
                        boolean ready = value != null && (value.contains("invoice") || value.contains("body"));
                        if (ready || attempt >= READY_ATTEMPTS) {
                            capturePageTextAndPrint(state);
                        } else {
                            state.handler.postDelayed(new Runnable() {
                                @Override
                                public void run() {
                                    waitForInvoice(state, attempt + 1);
                                }
                            }, 400L);
                        }
                    }
                });
    }

    private static void capturePageTextAndPrint(final RenderState state) {
        if (state.finished.get() || state.webView == null) return;
        state.webView.evaluateJavascript(
                "(function(){return document.body&&document.body.innerText?document.body.innerText:'';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (state.finished.get()) return;
                        try {
                            Object parsed = new JSONTokener(value == null ? "\"\"" : value).nextValue();
                            state.pageText = parsed == null ? "" : String.valueOf(parsed);
                        } catch (Exception ignored) {
                            state.pageText = "";
                        }
                        printWebView(state);
                    }
                });
    }

    private static void printWebView(final RenderState state) {
        if (state.finished.get() || state.webView == null || state.printStarted) return;
        state.printStarted = true;
        try {
            state.output = new File(state.context.getCacheDir(), "fleet-invoice-" + UUID.randomUUID() + ".pdf");
            final PrintDocumentAdapter adapter = state.webView.createPrintDocumentAdapter(safeName(state.documentName));
            final PrintAttributes attributes = new PrintAttributes.Builder()
                    // Impact declares A3 in @page. Keeping that size avoids
                    // shrinking or cutting the invoice during the conversion.
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A3)
                    .setResolution(new PrintAttributes.Resolution("fleet-control", "Fleet Control", 300, 300))
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build();
            final CancellationSignal signal = new CancellationSignal();
            adapter.onLayout(null, attributes, signal, new FleetLayoutResultCallback(new FleetLayoutResultCallback.Listener() {
                @Override
                public void finished(PrintDocumentInfo info, boolean changed) {
                    if (state.finished.get()) return;
                    try {
                        final ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(state.output,
                                ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_TRUNCATE);
                        adapter.onWrite(new PageRange[]{PageRange.ALL_PAGES}, descriptor, signal,
                                new FleetWriteResultCallback(new FleetWriteResultCallback.Listener() {
                                    @Override
                                    public void finished(PageRange[] pages) {
                                        closeDescriptor(descriptor);
                                        finishSuccess(state);
                                    }

                                    @Override
                                    public void failed(CharSequence error) {
                                        closeDescriptor(descriptor);
                                        finishFailure(state, new IOException(String.valueOf(error == null ? "Αποτυχία εγγραφής PDF." : error)));
                                    }

                                    @Override
                                    public void cancelled() {
                                        closeDescriptor(descriptor);
                                        finishFailure(state, new IOException("Η δημιουργία PDF ακυρώθηκε."));
                                    }
                                }));
                    } catch (Throwable error) {
                        finishFailure(state, error);
                    }
                }

                @Override
                public void failed(CharSequence error) {
                    finishFailure(state, new IOException(String.valueOf(error == null ? "Αποτυχία προετοιμασίας PDF." : error)));
                }

                @Override
                public void cancelled() {
                    finishFailure(state, new IOException("Η προετοιμασία PDF ακυρώθηκε."));
                }
            }), new Bundle());
        } catch (Throwable error) {
            finishFailure(state, error);
        }
    }

    private static String safeName(String value) {
        String name = value == null ? "invoice-qr.pdf" : value.replaceAll("[^a-zA-Z0-9._-]+", "_");
        if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
        return name.length() > 100 ? name.substring(name.length() - 100) : name;
    }

    private static void finishSuccess(RenderState state) {
        if (!state.finished.compareAndSet(false, true)) return;
        if (state.timeout != null) state.handler.removeCallbacks(state.timeout);
        destroyWebView(state);
        state.finishedLatch.countDown();
    }

    private static void finishFailure(RenderState state, Throwable error) {
        if (!state.finished.compareAndSet(false, true)) return;
        state.error = error == null ? new IOException("Αποτυχία δημιουργίας PDF.") : error;
        if (state.timeout != null) state.handler.removeCallbacks(state.timeout);
        destroyWebView(state);
        if (state.output != null && state.output.exists()) state.output.delete();
        state.finishedLatch.countDown();
    }

    private static void destroyWebView(RenderState state) {
        if (state.webView == null) return;
        try {
            state.webView.stopLoading();
            state.webView.loadUrl("about:blank");
            state.webView.destroy();
        } catch (Throwable ignored) {
        }
        state.webView = null;
    }

    private static void closeDescriptor(ParcelFileDescriptor descriptor) {
        try { descriptor.close(); } catch (IOException ignored) {}
    }

    private static final class RenderState {
        final Context context;
        final String pageUrl;
        final String documentName;
        final CountDownLatch finishedLatch;
        final AtomicBoolean finished = new AtomicBoolean(false);
        Handler handler;
        WebView webView;
        Runnable timeout;
        File output;
        String pageText = "";
        Throwable error;
        boolean printStarted;

        RenderState(Context context, String pageUrl, String documentName, CountDownLatch finishedLatch) {
            this.context = context;
            this.pageUrl = pageUrl;
            this.documentName = documentName;
            this.finishedLatch = finishedLatch;
        }
    }

    public static final class RenderedDocument {
        public final File output;
        public final String pageText;

        RenderedDocument(File output, String pageText) {
            this.output = output;
            this.pageText = pageText == null ? "" : pageText;
        }
    }
}
