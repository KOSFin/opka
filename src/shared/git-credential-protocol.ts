export type GitCredentialRequest = {
  protocol: 'https'
  host: string
  path?: string
  username?: string
}

export type GitCredentialResponse = {
  username: string
  password: string
}

export function isGitCredentialRequest(value: unknown): value is GitCredentialRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const keys = Object.keys(value)
  if (keys.some((key) => !['protocol', 'host', 'path', 'username'].includes(key))) {
    return false
  }
  if (!('protocol' in value) || !('host' in value)) {
    return false
  }
  return (
    value.protocol === 'https' &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    !/[\s/@\0]/.test(value.host) &&
    (!('path' in value) || (typeof value.path === 'string' && !/[\r\n\0\\]/.test(value.path))) &&
    (!('username' in value) ||
      (typeof value.username === 'string' && !/[\r\n\0]/.test(value.username)))
  )
}

export function isGitCredentialResponse(value: unknown): value is GitCredentialResponse {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== 'password,username'
  ) {
    return false
  }
  if (!('username' in value) || !('password' in value)) {
    return false
  }
  const { username, password } = value
  return (
    typeof username === 'string' &&
    username.length > 0 &&
    !/[\r\n\0]/.test(username) &&
    typeof password === 'string' &&
    password.length > 0 &&
    !/[\r\n\0]/.test(password)
  )
}
