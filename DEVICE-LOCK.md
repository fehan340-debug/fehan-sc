# Device Lock

The subscription remains locked to one physical device, but is no longer locked to one browser.

- Each browser still gets its own `scanner_device_id`.
- The client also sends a browser-independent device fingerprint based on stable device characteristics.
- Safari, Chrome and Google Chrome on the same phone/computer can therefore use the same account.
- A genuinely different device with a different fingerprint is rejected with `هذا الحساب مرتبط بجهاز آخر.`
- Admin reset clears both `deviceId` and `deviceFingerprint`.

This is a web-level device lock, not a cryptographic hardware identity. Browsers can restrict or change fingerprintable characteristics, so it is designed as a practical single-device control rather than an unforgeable hardware lock.
