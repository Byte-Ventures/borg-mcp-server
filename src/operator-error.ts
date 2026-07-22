export type OperatorErrorCode =
  | "START_LAN_DUPLICATE"
  | "START_HOST_DUPLICATE"
  | "START_PORT_DUPLICATE"
  | "START_HOST_MISSING"
  | "START_PORT_MISSING"
  | "START_PORT_INVALID"
  | "START_LOG_LEVEL_DUPLICATE"
  | "START_LOG_LEVEL_MISSING"
  | "START_LOG_LEVEL_INVALID"
  | "START_OPTION_UNKNOWN"
  | "BIND_PORT_INVALID"
  | "BIND_HOST_INVALID"
  | "BIND_WILDCARD"
  | "BIND_PUBLIC"
  | "BIND_LAN_CONSENT"
  | "SERVER_FILES_MISSING"
  | "DATA_PATH_SYMLINK"
  | "INSTALLATION_EXISTS"
  | "LAN_CA_KEY_ONLINE"
  | "RUNTIME_ACTIVE"
  | "RUNTIME_LOCK_UNSAFE"
  | "RUNTIME_LOCK_INVALID"
  | "RUNTIME_LOCK_LIVE_UNRECOGNIZED"
  | "RUNTIME_LOCK_STALE"
  | "RUNTIME_ARTIFACT_INSTALL_FAILED"
  | "ACTIVITY_LIMIT_INVALID"
  | "DATABASE_LIMIT_INVALID"
  | "DISK_RESERVE_INVALID"
  | "CLIENT_NOT_FOUND"
  | "GRANT_NOT_FOUND"
  | "RECOVERY_INVALID"
  | "INVITATION_BUSY"
  | "INVITATION_CONTENTION"
  | "INVITATION_SCHEMA_MISMATCH"
  | "INVITATION_CUBE_NOT_FOUND"
  | "INVITATION_CUBE_SELECTOR_INVALID"
  | "INVITATION_CUBE_AMBIGUOUS";

const publicMessages: Readonly<Record<OperatorErrorCode, string>> = Object.freeze({
  START_LAN_DUPLICATE: "Provide --lan only once.",
  START_HOST_DUPLICATE: "Provide --host only once.",
  START_PORT_DUPLICATE: "Provide --port only once.",
  START_HOST_MISSING: "Provide an IP address after --host.",
  START_PORT_MISSING: "Provide a port number after --port.",
  START_PORT_INVALID: "Provide --port as an integer from 0 to 65535.",
  START_LOG_LEVEL_DUPLICATE: "Provide --log-level only once.",
  START_LOG_LEVEL_MISSING: "Provide debug after --log-level.",
  START_LOG_LEVEL_INVALID: "Use --log-level debug or omit the option.",
  START_OPTION_UNKNOWN: "Use only documented start options; run borg-mcp-server help.",
  BIND_PORT_INVALID: "Configure the listen port as an integer from 0 to 65535.",
  BIND_HOST_INVALID: "Configure --host as an explicit IP address.",
  BIND_WILDCARD: "Choose a specific loopback or private-LAN IP; wildcard binds are prohibited.",
  BIND_PUBLIC: "Choose a loopback or private-LAN IP; public-routable binds are unsupported.",
  BIND_LAN_CONSENT: "Add --lan to consent to this private-LAN start.",
  SERVER_FILES_MISSING: "Configure BORG_SERVER_DATA_DIR or the required TLS file variables.",
  DATA_PATH_SYMLINK: "Choose a BORG_SERVER_DATA_DIR path that contains no symbolic links.",
  INSTALLATION_EXISTS: "An installation already exists in BORG_SERVER_DATA_DIR. To destroy and recreate it, stop the server and run borg-mcp-server setup --reinitialize.",
  LAN_CA_KEY_ONLINE: "Move ca.key out of the runtime data directory before private-LAN startup.",
  RUNTIME_ACTIVE: "Stop the server before running setup or offline administration.",
  RUNTIME_LOCK_UNSAFE: "Ensure runtime.lock is a private regular file before retrying.",
  RUNTIME_LOCK_INVALID: "Confirm the server is stopped, then remove the invalid runtime.lock.",
  RUNTIME_LOCK_LIVE_UNRECOGNIZED: "A live process owns runtime.lock. Stop the server through a supported command; do not remove the lock.",
  RUNTIME_LOCK_STALE: "Confirm the recorded server process is stopped, then remove runtime.lock.",
  RUNTIME_ARTIFACT_INSTALL_FAILED: "Setup could not prepare the verified runtime.\nNext: check your Node.js and npm installation, then rerun setup.",
  ACTIVITY_LIMIT_INVALID: "Set BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE to a positive integer.",
  DATABASE_LIMIT_INVALID: "Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer.",
  DISK_RESERVE_INVALID: "Set BORG_SERVER_MIN_FREE_DISK_BYTES to a positive integer.",
  CLIENT_NOT_FOUND: "Provide an existing active client ID.",
  GRANT_NOT_FOUND: "Provide an existing client cube grant.",
  RECOVERY_INVALID: "Provide the active recovery credential through the private prompt.",
  INVITATION_BUSY: "Confirm no invitation or offline administration command is running, then remove invitation-mint.lock.",
  INVITATION_CONTENTION: "Retry invitation minting after the current server database write completes.",
  INVITATION_SCHEMA_MISMATCH: "Invitation minting is unavailable while a server with an incompatible schema is running. Stop the server and rerun this command, or use the CLI version that matches the running server.",
  INVITATION_CUBE_NOT_FOUND: "Provide an existing cube name or full cube ID.",
  INVITATION_CUBE_SELECTOR_INVALID: "Provide a full canonical cube UUID or an exact case-sensitive cube name.",
  INVITATION_CUBE_AMBIGUOUS: "Cube name is ambiguous. Rerun with the full cube ID.",
});

const operatorErrorCodes = new WeakMap<object, OperatorErrorCode>();
const operatorErrorMessages = new WeakMap<object, string>();
const operatorErrorCapability = Object.freeze({});

class OperatorError extends Error {
  readonly #operatorCode: OperatorErrorCode;

  constructor(capability: object, code: OperatorErrorCode, publicMessage?: string) {
    super(publicMessage ?? (Object.hasOwn(publicMessages, code) ? publicMessages[code] : "Operator error rejected."));
    if (capability !== operatorErrorCapability || !Object.hasOwn(publicMessages, code)) {
      throw new Error("Operator error construction is unavailable.");
    }
    this.name = "OperatorError";
    this.#operatorCode = code;
    operatorErrorCodes.set(this, code);
    operatorErrorMessages.set(this, this.message);
    Object.freeze(this);
  }

  get code(): OperatorErrorCode {
    return this.#operatorCode;
  }

  get publicMessage(): string {
    return operatorErrorMessages.get(this) ?? publicMessages[this.#operatorCode];
  }
}

export const operatorErrors: Readonly<Record<OperatorErrorCode, Error>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(publicMessages) as OperatorErrorCode[]).map((code) => [
      code,
      new OperatorError(operatorErrorCapability, code),
    ]),
  ) as unknown as Record<OperatorErrorCode, Error>,
);

export function operatorPublicMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = operatorErrorCodes.get(error);
  if (code === undefined) return null;
  if (Object.getPrototypeOf(error) !== OperatorError.prototype || !Object.isFrozen(error)) return null;
  return operatorErrorMessages.get(error) ?? publicMessages[code];
}

export function invitationCubeAmbiguousError(candidateIds: readonly string[]): Error {
  if (candidateIds.length < 2 || candidateIds.some((id) =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))) {
    throw new Error("Ambiguous cube candidates must contain canonical cube IDs.");
  }
  return new OperatorError(
    operatorErrorCapability,
    "INVITATION_CUBE_AMBIGUOUS",
    `Cube name is ambiguous. Rerun with the full cube ID. Candidate cube IDs: ${candidateIds.join(", ")}`,
  );
}
