# JSON-java for storage regression tests only

Upstream: https://github.com/stleary/JSON-java/tree/20240303

Binary: https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar

SHA-256: `3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed`

The pinned upstream jar lets native storage tests parse real large Unicode JSON. It is not included in either Android APK or its runtime dependency classpath. The upstream license is included alongside it. Tests run offline after cloning the full repository.
