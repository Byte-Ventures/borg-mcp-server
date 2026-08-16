import { assertCanonicalUuid } from "./principal.js";

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
  | "SETUP_BIND_SCOPE_UNSUPPORTED"
  | "SETUP_OWNER_CREDENTIAL_FAILED"
  | "INSTALLATION_EXISTS"
  | "OWNER_CREDENTIAL_UNAVAILABLE"
  | "CA_MATERIAL_UNAVAILABLE"
  | "LAN_CA_KEY_ONLINE"
  | "RUNTIME_ACTIVE"
  | "RUNTIME_LOCK_UNSAFE"
  | "RUNTIME_LOCK_INVALID"
  | "RUNTIME_LOCK_LIVE_UNRECOGNIZED"
  | "RUNTIME_LOCK_STALE"
  | "RUNTIME_LOCK_NOT_STALE"
  | "RUNTIME_LOCK_RECOVERY_CONCURRENT"
  | "MANAGED_SERVICE_DEFINITION_UNSAFE"
  | "MANAGED_SERVICE_DEFINITION_FOREIGN"
  | "MANAGED_SERVICE_REGISTRATION_LEFTOVER"
  | "MANAGED_SERVICE_LOG_UNSAFE"
  | "MANAGED_SERVICE_DATA_UNINITIALIZED"
  | "MANAGED_SERVICE_RUNTIME_UNPREPARED"
  | "MANAGED_SERVICE_FOREGROUND_ACTIVE"
  | "MANAGED_SERVICE_LAN_UNSUPPORTED"
  | "MANAGED_SERVICE_INSTALL_BUSY"
  | "MANAGED_SERVICE_UNINSTALL_BUSY"
  | "MANAGED_SERVICE_PLATFORM_UNSUPPORTED"
  | "MANAGED_SERVICE_UNINSTALL_PLATFORM_UNSUPPORTED"
  | "RUNTIME_ARTIFACT_INSTALL_FAILED"
  | "DASHBOARD_INSTALLATION_MISSING"
  | "DASHBOARD_SERVER_STOPPED"
  | "DASHBOARD_DATA_UNAVAILABLE"
  | "ACTIVITY_LIMIT_INVALID"
  | "DECISION_BUDGET_INVALID"
  | "DOCUMENT_BUDGET_INVALID"
  | "LOG_ENTRY_LIMIT_INVALID"
  | "CONTEXT_GUIDELINE_INVALID"
  | "DATABASE_LIMIT_INVALID"
  | "DISK_RESERVE_INVALID"
  | "CLIENT_NOT_FOUND"
  | "CLIENT_SELECTOR_NOT_FOUND"
  | "CLIENT_REVOKED"
  | "GRANT_NOT_FOUND"
  | "CUBE_ID_INVALID"
  | "INVITATION_BUSY"
  | "INVITATION_CONTENTION"
  | "LIVE_ADMIN_CONTENTION"
  | "INVITATION_SCHEMA_MISMATCH"
  | "CLIENT_NAME_CONFLICT"
  | "INVITATION_NAME_CONFLICT"
  | "CLIENT_SELECTOR_AMBIGUOUS";

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
  SETUP_BIND_SCOPE_UNSUPPORTED: "The IPv6 address includes a zone index. No newly generated server identity was kept.\nNext: use the machine's private IPv4 address, then rerun setup.",
  SETUP_OWNER_CREDENTIAL_FAILED: "Setup could not save the local owner credential. No newly generated server identity was kept.\nNext: confirm ~/.borg/credentials is private and writable, then rerun setup.",
  INSTALLATION_EXISTS: "An installation already exists in BORG_SERVER_DATA_DIR. To destroy and recreate it, stop the server and run borg-mcp-server setup --reinitialize.",
  OWNER_CREDENTIAL_UNAVAILABLE: "The local owner credential is unavailable. Restore the local credential store from backup, or preserve any needed server data and run borg-mcp-server setup --reinitialize to create a new database and leaf identity while preserving the CA when present.",
  CA_MATERIAL_UNAVAILABLE: "The existing CA certificate and private key are required for reinitialization. Restore both files or follow the documented CA-loss recovery procedure; no server data was changed.",
  LAN_CA_KEY_ONLINE: "Move ca.key out of the runtime data directory before private-LAN startup.",
  RUNTIME_ACTIVE: "Stop the server before running setup or offline administration.",
  RUNTIME_LOCK_UNSAFE: "Ensure runtime.lock is a private regular file before retrying.",
  RUNTIME_LOCK_INVALID: "Confirm the server is stopped, then remove the invalid runtime.lock.",
  RUNTIME_LOCK_LIVE_UNRECOGNIZED: "A live process owns runtime.lock. Stop the server through a supported command; do not remove the lock.",
  RUNTIME_LOCK_STALE: "Confirm the recorded server process is stopped, then remove runtime.lock.",
  RUNTIME_LOCK_NOT_STALE: "No safely recoverable stale runtime lock was found.",
  RUNTIME_LOCK_RECOVERY_CONCURRENT: "Another recovery already preserved runtime.lock. Rerun status.",
  MANAGED_SERVICE_DEFINITION_UNSAFE: "Ensure the managed service definition is an owner-private regular file, then retry.",
  MANAGED_SERVICE_DEFINITION_FOREIGN: "The existing service definition is not recognized as Borg-owned. Preserve or remove it manually before retrying.",
  MANAGED_SERVICE_REGISTRATION_LEFTOVER: "No Borg service definition is present, but the service manager still reports ai.borgmcp.server. Remove the leftover registration, then retry:\n  macOS: launchctl bootout gui/$(id -u)/ai.borgmcp.server\n  Linux: systemctl --user disable --now ai.borgmcp.server",
  MANAGED_SERVICE_LOG_UNSAFE: "Ensure managed service log sinks are owner-owned regular files, then retry.",
  MANAGED_SERVICE_DATA_UNINITIALIZED: "Run borg-mcp-server setup before installing the managed service.",
  MANAGED_SERVICE_RUNTIME_UNPREPARED: "Run borg-mcp-server setup or update before installing the managed service.",
  MANAGED_SERVICE_FOREGROUND_ACTIVE: "Stop the foreground server with Ctrl-C before installing the managed service.",
  MANAGED_SERVICE_LAN_UNSUPPORTED: "Managed service installation is loopback-only. Use foreground start for private-LAN operation.",
  MANAGED_SERVICE_INSTALL_BUSY: "Another managed service installation is running. Wait for it to finish, then retry.",
  MANAGED_SERVICE_UNINSTALL_BUSY: "Another managed service change is running. Wait for it to finish, then retry.",
  MANAGED_SERVICE_PLATFORM_UNSUPPORTED: "Managed service installation supports macOS launchd and Linux systemd user services only.",
  MANAGED_SERVICE_UNINSTALL_PLATFORM_UNSUPPORTED: "Managed service uninstallation supports macOS launchd and Linux systemd user services only.",
  RUNTIME_ARTIFACT_INSTALL_FAILED: "Setup could not prepare the verified runtime.\nNext: check your Node.js and npm installation, then rerun setup.",
  DASHBOARD_INSTALLATION_MISSING: "Prepare the local server in BORG_SERVER_DATA_DIR before opening the dashboard.",
  DASHBOARD_SERVER_STOPPED: "Start the local server before opening the dashboard.",
  DASHBOARD_DATA_UNAVAILABLE: "Dashboard data is unavailable. Check that BORG_SERVER_DATA_DIR is private and readable, then retry.",
  ACTIVITY_LIMIT_INVALID: "Set BORG_SERVER_MAX_ACTIVITY_ENTRIES_PER_CUBE to a positive integer.",
  DECISION_BUDGET_INVALID: "Set BORG_SERVER_MAX_ACTIVE_DECISION_BYTES_PER_CUBE to a positive integer.",
  DOCUMENT_BUDGET_INVALID: "Set document byte budgets to positive integers with BORG_SERVER_MAX_DOCUMENT_BYTES no greater than BORG_SERVER_MAX_ACTIVE_DOCUMENT_BYTES_PER_CUBE.",
  LOG_ENTRY_LIMIT_INVALID: "Set log entry byte limits to positive integers with BORG_SERVER_LOG_ENTRY_ADVISORY_BYTES no greater than BORG_SERVER_MAX_LOG_ENTRY_BYTES and the hard limit no greater than 10240.",
  CONTEXT_GUIDELINE_INVALID: "Set BORG_SERVER_CONTEXT_GUIDELINE_BYTES to a positive integer.",
  DATABASE_LIMIT_INVALID: "Set BORG_SERVER_MAX_DATABASE_BYTES to a positive integer.",
  DISK_RESERVE_INVALID: "Set BORG_SERVER_MIN_FREE_DISK_BYTES to a positive integer.",
  CLIENT_NOT_FOUND: "Provide an existing active client ID.",
  CLIENT_SELECTOR_NOT_FOUND: "Provide an existing client name, handle, or ID.",
  CLIENT_REVOKED: "Client exists but is revoked.",
  GRANT_NOT_FOUND: "Provide an existing client cube grant.",
  CUBE_ID_INVALID: "Provide the cube UUID shown by `client-list`.",
  INVITATION_BUSY: "Confirm no invitation or offline administration command is running, then remove invitation-mint.lock.",
  INVITATION_CONTENTION: "Retry invitation minting after the current server database write completes.",
  LIVE_ADMIN_CONTENTION: "Retry the live client authorization change after the current server database write completes.",
  INVITATION_SCHEMA_MISMATCH: "Invitation minting is unavailable while a server with an incompatible schema is running. Stop the server and rerun this command, or use the CLI version that matches the running server.",
  CLIENT_NAME_CONFLICT: "A client with this name already exists. Choose another name, or revoke the existing client before reusing it.",
  INVITATION_NAME_CONFLICT: "An unclaimed invitation with this label is outstanding. Choose another name, or wait for it to expire before reusing the label.",
  CLIENT_SELECTOR_AMBIGUOUS: "Client name is ambiguous. Use a listed client handle.",
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

export function ambiguousClientSelector(
  kind: "name" | "handle" | "selector",
  selectors: readonly string[],
): Error {
  if (selectors.length < 2 ||
      selectors.some((selector) => !isSafeClientDisambiguator(selector)) ||
      new Set(selectors).size !== selectors.length) {
    throw new Error("Ambiguous client selectors are invalid.");
  }
  const choices = [...selectors].sort().join(", ");
  return new OperatorError(
    operatorErrorCapability,
    "CLIENT_SELECTOR_AMBIGUOUS",
    kind === "name"
      ? `Client name is ambiguous. Use one of these selectors: ${choices}.`
      : kind === "handle"
        ? `Client handle now matches more than one client. Use one of these selectors: ${choices}.`
        : `Client selector matches more than one client. Use one of these selectors: ${choices}.`,
  );
}

function isSafeClientDisambiguator(selector: string): boolean {
  if (/^[0-9a-f]{8,32}$/u.test(selector)) return true;
  if (!selector.startsWith("id:")) return false;
  try {
    assertCanonicalUuid(selector.slice(3), "Client id");
    return true;
  } catch {
    return false;
  }
}

export function operatorPublicMessage(error: unknown): string | null {
  return operatorPublicDetails(error)?.message ?? null;
}

export function operatorPublicDetails(
  error: unknown,
): Readonly<{ code: OperatorErrorCode; message: string }> | null {
  if (typeof error !== "object" || error === null) return null;
  const code = operatorErrorCodes.get(error);
  if (code === undefined) return null;
  if (Object.getPrototypeOf(error) !== OperatorError.prototype || !Object.isFrozen(error)) return null;
  return Object.freeze({
    code,
    message: operatorErrorMessages.get(error) ?? publicMessages[code],
  });
}
