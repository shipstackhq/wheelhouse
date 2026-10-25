/** A bad, missing or expired device token or assertion; the daemon exception filter answers it 401 with a `WWW-Authenticate` header. */
export class DeviceAuthError extends Error {
  status = 401;
}
