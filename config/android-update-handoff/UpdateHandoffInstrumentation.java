package com.kosfin.opka.mobile.acceptance;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.content.pm.PackageInfo;
import java.io.File;
import java.io.InputStream;
import java.security.MessageDigest;

/** CI only: invoke the OS installer as the target app, without exporting a production component. */
public final class UpdateHandoffInstrumentation extends Instrumentation {
    private Bundle arguments;
    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    @Override
    public void onStart() {
        Context target = getTargetContext();
        if (!"com.kosfin.opka.mobile".equals(target.getPackageName())) {
            throw new IllegalStateException("Unexpected instrumentation target");
        }
        int uid = android.os.Process.myUid();
        if (uid != target.getApplicationInfo().uid) {
            throw new IllegalStateException("Installer handoff is not running as the target UID");
        }
        Uri uri = Uri.parse("content://com.kosfin.opka.mobile.opka-updates/opka-updates/update.apk");
        Bundle result = new Bundle();
        result.putInt("uid", uid);
        result.putInt("targetUid", target.getApplicationInfo().uid);
        File apk = new File(target.getCacheDir(), "opka-updates/update.apk");
        result.putBoolean("cacheExists", apk.exists());
        result.putBoolean("cacheCanRead", apk.canRead());
        result.putLong("cacheBytes", apk.length());
        String stage = "probe-arguments";
        try {
            String expectedHash = arguments.getString("expected_sha256");
            long expectedBytes = Long.parseLong(arguments.getString("expected_bytes"));
            long expectedCode = Long.parseLong(arguments.getString("expected_code"));
            result.putLong("expectedCode", expectedCode);
            result.putLong("expectedBytes", expectedBytes);
            if (expectedHash == null || !expectedHash.matches("[a-f0-9]{64}") || expectedBytes <= 0) {
                throw new IllegalArgumentException("Invalid expected fixture identity");
            }
            stage = "content-resolver-read";
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long bytes = 0;
            try (InputStream stream = target.getContentResolver().openInputStream(uri)) {
                if (stream == null) throw new IllegalStateException("ContentResolver returned no stream");
                byte[] buffer = new byte[65536];
                int length;
                while ((length = stream.read(buffer)) != -1) {
                    digest.update(buffer, 0, length);
                    bytes += length;
                }
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : digest.digest()) hash.append(String.format("%02x", value & 255));
            result.putString("sha256", hash.toString());
            result.putLong("bytes", bytes);
            stage = "content-identity";
            if (!expectedHash.equals(hash.toString()) || expectedBytes != bytes) {
                throw new IllegalStateException("FileProvider bytes differ from fixture B");
            }
            stage = "archive-parse";
            PackageInfo archive = target.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
            if (archive == null) throw new IllegalStateException("Android could not parse fixture B");
            long archiveCode = android.os.Build.VERSION.SDK_INT >= 28
                ? archive.getLongVersionCode() : archive.versionCode;
            result.putString("archivePackage", archive.packageName);
            result.putLong("archiveVersion", archiveCode);
            stage = "archive-identity";
            if (!target.getPackageName().equals(archive.packageName) || archiveCode != expectedCode) {
                throw new IllegalStateException("Android archive identity differs from fixture B");
            }
            result.putString("probe", "passed");
            sendStatus(0, result);
            stage = "installer-launch";
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            target.startActivity(intent);
            result.putString("handoff", "target-app-uid");
            sendStatus(0, result);
        } catch (Exception error) {
            result.putString("probe", "failed");
            result.putString("probeStage", stage);
            result.putString("probeException", error.getClass().getSimpleName());
            String message = error.getMessage();
            if (message != null) {
                message = message.replace('\n', ' ').replace('\r', ' ');
                result.putString("probeMessage", message.substring(0, Math.min(180, message.length())));
            }
            sendStatus(-1, result);
            finish(Activity.RESULT_CANCELED, result);
            return;
        }
        // Finishing instrumentation force-stops its target and revokes the installer's URI grant.
        android.os.SystemClock.sleep(360_000);
        finish(Activity.RESULT_CANCELED, result);
    }
}
