export const productionSecurityChecks = [
  'accountAllowlist', 'metadataOnly', 'crossAccountIsolation', 'invalidSelectionDoesNotStart',
  'onlineControls', 'allowedHttps', 'guestHeaderSpoofing', 'sameKeyReplay', 'domainDenial',
  'redirectDenial', 'reflectionDenial', 'publicTcpDnsDenial', 'publicUdpDnsDenial', 'alternatePortDenial',
  'caTampering', 'rotationDuringRequest', 'rotation', 'guestCredentialScan', 'protectedPreview',
  'previewWebSocket', 'filesystemFork', 'stopResume', 'snapshotCredentialScan', 'staleGeneration',
  'deletionDuringRequest', 'deletedBindingDenial', 'emptyAllowDenial', 'cidrDenial', 'exactStartBudget',
] as const;

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
  cleanup: { completed: boolean; remainingOwnedContainers: number | null; remainingOwnedSecrets: number | null;
    remainingOwnedWorkspaces: number | null; upstreamAbsent: boolean; baselinePreserved: boolean; errors: string[] };
}) {
  return report.target === 'restricted-production-api-runtime-relay-tls'
    && !report.interruptedBy && report.errors.length === 0
    && productionSecurityChecks.every(name => report.checks[name] === true)
    && report.startsRequested === 6 && report.startDelta === 6 && report.secondaryStartDelta === 0 && report.captureDelta === 2
    && ['api', 'runtime', 'relay', 'ack'].every(name => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(report.deployedVersions[name] ?? ''))
    && /^registry\.cloudflare\.com\/[^\s]+@sha256:[a-f0-9]{64}$/.test(report.imageDigest ?? '')
    && report.cleanup.completed && report.cleanup.errors.length === 0 && report.cleanup.baselinePreserved
    && report.cleanup.remainingOwnedContainers === 0 && report.cleanup.remainingOwnedSecrets === 0
    && report.cleanup.remainingOwnedWorkspaces === 0 && report.cleanup.upstreamAbsent;
}
