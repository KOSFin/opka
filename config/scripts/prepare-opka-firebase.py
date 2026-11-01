"""Prepare only Opka's explicit CI Firebase input; never use the upstream file."""
import hashlib
import json
import os
from pathlib import Path


def validate_configuration(raw):
    try:
        config = json.loads(raw)
        project = config['project_info']
        clients = config['client']
        matching = [client for client in clients if
                    client['client_info']['android_client_info']['package_name'] ==
                    'com.kosfin.opka.mobile']
        if not project.get('project_id') or not project.get('project_number') or not matching:
            raise ValueError()
        if not all(client['client_info'].get('mobilesdk_app_id') for client in matching):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ValueError('Invalid own Opka Firebase Android configuration') from None
    return config


def build_environment_fingerprint(environment):
    values = {key: value for key, value in environment.items() if key.startswith('EXPO_PUBLIC_')}
    values.update({
        'OPKA_MOBILE_BUILD': environment.get('OPKA_MOBILE_BUILD') == '1',
        'ORCA_IOS_APS_ENVIRONMENT': 'production' if environment.get('ORCA_IOS_APS_ENVIRONMENT') ==
        'production' else 'development',
        'NODE_ENV': environment.get('NODE_ENV'),
    })
    encoded = json.dumps(values, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def main():
    raw = os.environ.get('OPKA_GOOGLE_SERVICES_JSON', '')
    configured = bool(raw.strip())
    client_sha256 = 'unconfigured'
    if configured:
        config = validate_configuration(raw)
        target = Path(os.environ['RUNNER_TEMP']) / 'opka-google-services.json'
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as prepared:
            os.fchmod(prepared.fileno(), 0o600)
            prepared.write(json.dumps(config))
        client_sha256 = hashlib.sha256(target.read_bytes()).hexdigest()
        with open(os.environ['GITHUB_ENV'], 'a') as env:
            env.write(f'OPKA_GOOGLE_SERVICES_FILE={target}\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'configured={str(configured).lower()}\n')
        output.write(f'client_sha256={client_sha256}\n')
        output.write(f'build_env_sha256={build_environment_fingerprint(os.environ)}\n')


if __name__ == '__main__':
    main()
