package gr.argyrismitsos.fleetserver;

/** Pure timing rules shared by the live OTA coordinator and regression tests. */
public final class OtaPolicy {
    public static final long CHECK_INTERVAL_MS = 60L * 60L * 1000L;
    public static final long RETRY_INTERVAL_MS = 15L * 60L * 1000L;
    private OtaPolicy() {}
    public static boolean checkDue(long now, long last, boolean force, boolean automatic) {
        return force || (automatic && (last <= 0 || now < last || now - last >= CHECK_INTERVAL_MS));
    }
    public static boolean yieldForUpdate(long now, long attempt, boolean ready, boolean requested, boolean automatic, boolean permission, boolean backupFolder) {
        return ready && permission && backupFolder && (requested || (automatic && (attempt <= 0 || now < attempt || now - attempt >= RETRY_INTERVAL_MS)));
    }
}
