package com.kosfin.opka.mobile.acceptance;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** CI only: invoke the OS installer as the target app, without exporting a production component. */
public final class UpdateHandoffInstrumentation extends Instrumentation {
    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
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
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        target.startActivity(intent);
        Bundle result = new Bundle();
        result.putString("handoff", "target-app-uid");
        result.putInt("uid", uid);
        result.putInt("targetUid", target.getApplicationInfo().uid);
        sendStatus(0, result);
        // Finishing instrumentation force-stops its target and revokes the installer's URI grant.
        android.os.SystemClock.sleep(360_000);
        finish(Activity.RESULT_CANCELED, result);
    }
}
