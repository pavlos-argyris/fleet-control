package android.print;

/** Package bridge for Android 23 print callback construction. */
public final class FleetWriteResultCallback extends PrintDocumentAdapter.WriteResultCallback {
    public interface Listener {
        void finished(PageRange[] pages);
        void failed(CharSequence error);
        void cancelled();
    }

    private final Listener listener;

    public FleetWriteResultCallback(Listener listener) {
        super();
        this.listener = listener;
    }

    @Override
    public void onWriteFinished(PageRange[] pages) {
        if (listener != null) listener.finished(pages);
    }

    @Override
    public void onWriteFailed(CharSequence error) {
        if (listener != null) listener.failed(error);
    }

    @Override
    public void onWriteCancelled() {
        if (listener != null) listener.cancelled();
    }
}
