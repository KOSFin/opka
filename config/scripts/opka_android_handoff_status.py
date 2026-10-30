"""Decode bounded diagnostic evidence from the CI-only target-UID probe."""
import re


def handoff_ready(text, expected_hash, expected_bytes, expected_code):
    fields = dict(re.findall(r'^INSTRUMENTATION_(?:STATUS|RESULT): ([A-Za-z0-9]+)=([^\r\n]*)', text, re.MULTILINE))
    if fields.get('probe') == 'failed':
        details = ', '.join(
            f'{key}={fields[key][:limit]}' for key, limit in [
                ('probeMessage', 180), ('cacheExists', 8), ('cacheCanRead', 8),
                ('cacheBytes', 24), ('bytes', 24), ('expectedBytes', 24),
                ('archivePackage', 100), ('archiveVersion', 24), ('expectedCode', 24)
            ] if key in fields
        )
        raise AssertionError(f"APK probe failed: {fields.get('probeStage', 'unknown')[:80]} / {fields.get('probeException', 'unknown')[:80]}; {details}")
    return (
        fields.get('handoff') == 'target-app-uid' and fields.get('probe') == 'passed'
        and fields.get('sha256') == expected_hash and fields.get('bytes') == str(expected_bytes)
        and fields.get('archiveVersion') == str(expected_code)
        and fields.get('archivePackage') == 'com.kosfin.opka.mobile'
        and fields.get('uid') is not None and fields.get('uid') == fields.get('targetUid')
    )
