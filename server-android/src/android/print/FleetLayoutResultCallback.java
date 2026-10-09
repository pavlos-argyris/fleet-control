package android.print;

/** Package bridge for Android 23, whose framework stub keeps the callback
 * constructor package-private even though the callback type is public. */
public final class FleetLayoutResultCallback extends PrintDocumentAdapter.LayoutResultCallback {
    public interface Listener {
        void finished(PrintDocumentInfo info, boolean changed);
        void failed(CharSequence error);
        void cancelled();
    }

    private final Listener listener;

    public FleetLayoutResultCallback(Listener listener) {
        super();
        this.listener = listener;
    }

    @Override
    public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
        if (listener != null) listener.finished(info, changed);
    }

    @Override
    public void onLayoutFailed(CharSequence error) {
        if (listener != null) listener.failed(error);
    }

    @Override
    public void onLayoutCancelled() {
        if (listener != null) listener.cancelled();
    }
}
