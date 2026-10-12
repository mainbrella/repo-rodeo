# Production egress and vault qualification

The [final production result](../examples/mainbrella-production-security/result.json)
passed all 29 bounded canary checks. The separate
[local rollout result](../examples/mainbrella-local-security-rollout/result.json)
passed 33 checks. Both results retain `releaseQualified: false`; customer access
was not enabled. The [withdrawal record](../examples/mainbrella-production-security/withdrawal.json)
confirms both production gates were turned off afterward, with zero guests in
either qualification account and zero running relay instances.

The production path used the customer API, native private runtime, a dedicated
Cloudflare HTTPS ingress and shared Lite Node relay, and a separate owned
acknowledgment Worker. The relay authenticates before starting its container,
pins validated public DNS addresses for real TLS transport, and sleeps after
60 seconds idle. The vault uses the existing account Durable Object and a
stable operator-managed encryption key. No raw credentials or protected preview
URLs appear in the public evidence.

During qualification, only account `03390581-7080-49a1-a942-ce82476196db` had
security access. The excluded account and anonymous discovery reported false;
excluded writes/admission were rejected before a guest start. Checks covered
metadata-only secret APIs, cross-account isolation, same-key replay, HTTPS
injection and guest-header stripping, domain/CIDR and raw TCP/UDP/alternate-port
denial, CA tampering, redirects and credential reflections. Rotation and deletion
during held upstream requests withheld the superseded responses. Credential
scans, protected HTTP and WebSocket previews, filesystem fork and stop/resume,
immutable policy/binding metadata, stale-generation rejection and empty-allow
denial also passed.

The combined budget was six guest starts and two captures. Primary monthly
starts increased from 133 to 139; the excluded account stayed at four. The final
continuation used four starts and two captures and retained hashed evidence of
the two earlier admissions:

- The [online control](../examples/mainbrella-production-security/online-control-result.json)
  consumed one start. A subsequent assertion incorrectly expected 404 instead of
  the excluded account's rollout rejection, 503. Cleanup succeeded.
- A [metadata-only retry](../examples/mainbrella-production-security/metadata-retry-result.json)
  consumed zero starts. It exposed another incorrect assertion: deletion of a
  foreign secret ID is an idempotent no-op in the caller's own vault. The final
  test verifies the owner's secret survives that operation.
- The [first restricted admission](../examples/mainbrella-production-security/spent-admission-result.json)
  consumed one start and passed 14 checks before discovering a fixture bug:
  the route matcher excluded digits in `reflect-base64`. The matcher was fixed;
  all three reflection actions were calibrated locally and on the owned service.
  Cleanup succeeded.
- The final continuation reused the pinned online controls, counted the spent
  admission, and tested CIDR denial in its main restricted guest. The API,
  runtime, relay, image and accounts stayed pinned across that continuation;
  the acknowledgment fixture revision is explicit in the report.

The qualified API was `aa8fca89-679b-4456-9c94-93ea66704b8f`, private runtime
`cd5e43ce-dc0e-45a5-8aab-189a2d92fbd9`, relay
`175737e7-c1b7-4610-9d21-87b15209a619`, and corrected acknowledgment service
`5c412798-46b0-4da6-9f07-2412136fbedc`. The report pins the Node image digest.
Withdrawal deployed API `71f2575b-e2c4-424e-9d82-c84415df5305` before runtime
`2aac23ba-0403-4913-acb4-20afe59c7995`.

Cleanup confirmed zero run-owned containers, secrets and workspaces in API
inventories, deletion of the upstream token/run, and preservation of baseline
resources. Physical provider snapshot erasure was not verified. Cloudflare
documents a 30-day snapshot lifetime that refreshes on restore; removing an API
workspace does not establish immediate physical deletion. See the
[native snapshot API](https://developers.cloudflare.com/containers/api/durable-object-container/#snapshotcontainer).
Scans checked `/workspace`, `/tmp`, self environment and argv after restore;
complete image/snapshot scans remain a release gate.

Other open gates are IPv6 and the full bypass matrix, expiry and provider
recovery, SSH/browser terminal, and deployed runtime downgrade and in-flight
deployment withdrawal. This result establishes the tested account-restricted
path; it does not qualify permanent public rollout. Checked-in configuration
keeps both flags false and the account list empty.

The [public manifest](../examples/mainbrella-production-security/manifest.json)
checksums the reports. Original source snapshots remain under
`artifacts/security-production-20261012-04/inputs/`; that directory also retains
the preceding online and spent-admission reports. The private operator
credential file stays in the backend's ignored `.wrangler` directory.
