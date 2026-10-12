import assert from 'node:assert/strict';

export const securityChecks = [
  'enabledDiscovery', 'vaultCiphertext', 'metadataOnly', 'crossAccountIsolation',
  'invalidSelectionDoesNotStart', 'allowedHttp', 'allowedHttps', 'guestHeaderSpoofing',
  'domainDenial', 'cidrDenial', 'mixedDnsDenial', 'redirectDenial', 'reflectionDenial',
  'rotation', 'rotationDuringRequest', 'deletionDuringRequest', 'deletedBindingDenial',
  'incarnationDuringRequest', 'configurationWithdrawal', 'guestCredentialScan',
  'sameKeyReplay', 'exactStartBudget', 'disabledDiscovery',
  'publicTcpDnsDenial', 'publicUdpDnsDenial', 'protectedPreview',
  'accountAllowlist', 'withdrawalDuringRequest', 'caTampering', 'filesystemFork', 'stopResume', 'snapshotCredentialScan', 'alternatePortDenial',
] as const;

export type SecurityCheck = typeof securityChecks[number];
export type SecurityReport = {
  target: string;
  checks: Partial<Record<SecurityCheck, boolean>>;
  errors: string[];
  interruptedBy?: string;
  cleanup: { completed: boolean; remainingContainers: number | null; remainingSecrets: number | null;
    remainingDockerContainers: string[] | null; remainingWorkspaces: number | null; remainingSnapshotImages: string[] | null; errors: string[] };
};

export function verifyLocalSecurity(report: SecurityReport): boolean {
  return report.target === 'isolated-local-api-runtime-relay-tls'
    && !report.interruptedBy && report.errors.length === 0
    && securityChecks.every(name => report.checks[name] === true)
    && report.cleanup.completed === true && report.cleanup.errors.length === 0
    && report.cleanup.remainingContainers === 0 && report.cleanup.remainingSecrets === 0
    && report.cleanup.remainingWorkspaces === 0
    && Array.isArray(report.cleanup.remainingSnapshotImages) && report.cleanup.remainingSnapshotImages.length === 0
    && Array.isArray(report.cleanup.remainingDockerContainers) && report.cleanup.remainingDockerContainers.length === 0;
}

export function assertAcknowledgment(value: unknown, runId: string, authenticated: boolean, version: number) {
  assert.deepEqual(value, { fixture: 'rodeo-security', runId, authenticated, version, internalHeaders: false });
}

export function assertNoCredentialLeak(bytes: string | Buffer, credentials: string[]) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (const credential of credentials.filter(Boolean)) {
    for (const form of new Set([credential, encodeURIComponent(credential), Buffer.from(credential).toString('base64'),
      JSON.stringify(credential).slice(1, -1)])) {
      // Never put the credential or the inspected response in an assertion error.
      assert.equal(content.includes(Buffer.from(form)), false, 'Credential appeared outside its trusted storage or transport');
    }
  }
}
