package gr.argyrismitsos.fleetserver;

public final class ServerConfig {
    public static final String DEFAULT_WORKER_URL = "https://fleet-control.pavlosargyris.workers.dev";
    public static final String SERVER_KEY = BuildSecrets.SERVER_KEY;
    public static final String SERVER_VERSION = "2.1.8";

    private ServerConfig() {
    }
}
