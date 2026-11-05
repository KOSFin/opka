/** Cached projection reads must not spawn another writer or change the owned native HOME. */
export async function qualifyDarwinRefreshCache({ read, measure, validate, initial }) {
  const measurements = []
  for (let index = 0; index < 4; index++) {
    validate(await read())
    const value = await measure()
    if (value.files !== initial.files || value.bytes !== initial.bytes) {
      throw new Error('Cached native access changed the owned HOME footprint')
    }
    measurements.push(value)
  }
  return measurements
}

export function assertDarwinRefreshAccess(snapshot, { identity, accessToken, refreshToken }) {
  if (
    !snapshot?.access ||
    !snapshot?.identity ||
    snapshot.access.accessToken !== accessToken ||
    snapshot.identity.accountUuid !== identity.accountUuid ||
    snapshot.identity.organizationUuid !== identity.organizationUuid ||
    snapshot.identity.emailAddress?.toLowerCase() !== identity.emailAddress.toLowerCase() ||
    JSON.stringify(snapshot).includes(refreshToken) ||
    Object.hasOwn(snapshot.access, 'refreshToken')
  ) {
    throw new Error('Native projection changed identity or exposed refresh credentials')
  }
}
