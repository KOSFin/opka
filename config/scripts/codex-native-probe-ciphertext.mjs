function syntheticEnvelope(byte) {
  const bytes = Buffer.alloc(73)
  bytes[0] = 0x80
  bytes.fill(byte, 9)
  return bytes.toString('base64url')
}

// Transport-shape fixtures only; these have no valid MAC, key or decryptable provider content.
export const SYNTHETIC_REASONING_CIPHERTEXT = syntheticEnvelope(0x53)
export const SYNTHETIC_COMPACTION_CIPHERTEXT = syntheticEnvelope(0x43)
