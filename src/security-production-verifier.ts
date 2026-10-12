export const productionSecurityChecks = [
  'accountAllowlist', 'metadataOnly', 'crossAccountIsolation', 'invalidSelectionDoesNotStart',
  'onlineControls', 'allowedHttps', 'guestHeaderSpoofing', 'sameKeyReplay', 'domainDenial',
  'redirectDenial', 'reflectionDenial', 'publicTcpDnsDenial', 'publicUdpDnsDenial', 'alternatePortDenial',
  'caTampering', 'rotationDuringRequest', 'rotation', 'guestCredentialScan', 'protectedPreview',
  'previewWebSocket', 'filesystemFork', 'stopResume', 'snapshotCredentialScan', 'staleGeneration',
  'deletionDuringRequest', 'deletedBindingDenial', 'emptyAllowDenial', 'cidrDenial', 'exactStartBudget',
] as const;

export function verifiedOnlineControl(report: {
  target: string; checks: Record<string, boolean>; startsRequested: number; startDelta?: number; captureDelta?: number;
  secondaryStartDelta?: number; upstreamOrigin: string; imageDigest?: string; accounts: { primary: string; secondary: string };
  deployedVersions: Record<string, string>; cleanup: { completed: boolean; errors: string[] };
  onlineProtocols?: { udpTxt: boolean; tcpDns: { validResponse?: boolean; answered?: boolean }; alternateTlsDns: { validResponse?: boolean; answered?: boolean } };
}, expected: { upstreamOrigin: string; accounts: { primary: string; secondary: string }; deployedVersions: Record<string, string> }, fixtureRevision = false) {
  return report.target === 'restricted-production-api-runtime-relay-tls' && report.checks.onlineControls === true
    && report.checks.accountAllowlist === true && report.startsRequested === 1 && report.startDelta === 1
    && report.captureDelta === 0 && report.secondaryStartDelta === 0 && report.cleanup.completed && report.cleanup.errors.length === 0
    && report.upstreamOrigin === expected.upstreamOrigin && report.accounts.primary === expected.accounts.primary && report.accounts.secondary === expected.accounts.secondary
    && ['api', 'runtime', 'relay', ...(fixtureRevision ? [] : ['ack'])].every(name => report.deployedVersions[name] === expected.deployedVersions[name])
    && report.onlineProtocols?.udpTxt === true && report.onlineProtocols.tcpDns.validResponse === true && report.onlineProtocols.tcpDns.answered === true
    && report.onlineProtocols.alternateTlsDns.validResponse === true && report.onlineProtocols.alternateTlsDns.answered === true
    && /^registry\.cloudflare\.com\/[^\s]+@sha256:[a-f0-9]{64}$/.test(report.imageDigest ?? '');
}

export function ownsSecurityResource(value: { name?: string; id: string; createdAt?: string; source?: { id: string; createdAt: string } },
  runId: string, identities: { id: string; createdAt: string }[]) {
  return value.name?.includes(runId) === true || identities.some(identity =>
    value.id === identity.id && value.createdAt === identity.createdAt
    || value.source?.id === identity.id && value.source?.createdAt === identity.createdAt);
}

export function verifyProductionSecurity(report: {
  target: string; checks: Record<string, boolean>; errors: string[]; interruptedBy?: string;
  startsRequested: number; startDelta?: number; captureDelta?: number; secondaryStartDelta?: number;
  deployedVersions: Record<string, string>; imageDigest?: string;
  carriedOnlineStarts?: number; onlineControl?: { sha256: string; verified: boolean };
  spentStarts?: number; spentEvidence?: { sha256: string; verified: boolean };
  cleanup: { completed: boolean; remainingOwnedContainers: number | null; remainingOwnedSecrets: number | null;
    remainingOwnedWorkspaces: number | null; upstreamAbsent: boolean; baselinePreserved: boolean; errors: string[] };
}) {
  return report.target === 'restricted-production-api-runtime-relay-tls'
    && !report.interruptedBy && report.errors.length === 0
    && productionSecurityChecks.every(name => report.checks[name] === true)
    && report.startsRequested + (report.carriedOnlineStarts ?? 0) + (report.spentStarts ?? 0) === 6 && report.startDelta === report.startsRequested && report.secondaryStartDelta === 0 && report.captureDelta === 2
    && (!report.carriedOnlineStarts || report.carriedOnlineStarts === 1 && report.onlineControl?.verified === true && /^[a-f0-9]{64}$/.test(report.onlineControl.sha256))
    && (!report.spentStarts || report.spentStarts === 1 && report.spentEvidence?.verified === true && /^[a-f0-9]{64}$/.test(report.spentEvidence.sha256))
    && ['api', 'runtime', 'relay', 'ack'].every(name => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(report.deployedVersions[name] ?? ''))
    && /^registry\.cloudflare\.com\/[^\s]+@sha256:[a-f0-9]{64}$/.test(report.imageDigest ?? '')
    && report.cleanup.completed && report.cleanup.errors.length === 0 && report.cleanup.baselinePreserved
    && report.cleanup.remainingOwnedContainers === 0 && report.cleanup.remainingOwnedSecrets === 0
    && report.cleanup.remainingOwnedWorkspaces === 0 && report.cleanup.upstreamAbsent;
}
