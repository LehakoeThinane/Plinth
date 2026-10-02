# Hub logo uploads

Configure `createApplication` or `createManagedApplication` with a `brandingStore`
to enable the hub admin upload form and logo endpoints. Development can use:

```js
import { LocalBrandingStore } from './src/storage/local-branding.js';
const brandingStore = new LocalBrandingStore({root: '.local/branding'});
// Pass brandingStore alongside the application's existing trusted adapters.
```

The deployment chooses the root. Keep it outside any HTTP static directory, with
private parent directories and service-only OS permissions/ACLs. `.local/` is
ignored by Git. This adapter persists across application instances on the same
filesystem. It does not provision AWS or provide shared storage across servers.
`npm run dev` remains a health shell; it does not enable this configured application.

An active hub owner/admin can `PUT /v1/hubs/{hub}/branding/logo` with raw PNG, JPEG
or WebP bytes and the matching image Content-Type. Do not send JSON, multipart,
filenames or paths. The body limit is 2 MiB and the decoded pixel limit is
4,194,304. Unsupported formats/MIME mismatches return 415; malformed or animated
images return 400; excessive request/output bytes return 413. Authority is checked
before reading the upload, again in the service, and by RLS when publishing.
Cookie writes require the existing host/hub session, Origin and CSRF checks.

Images are decoded, rotated, resized to fit 512 by 512 without enlargement, and
encoded as WebP. Output is capped at 512 KiB. Metadata is stripped by the decoder's
default output behaviour; original bytes are never served. See the official
[Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/) and
[output behaviour](https://sharp.pixelplumbing.com/api-output/).

The server generates the key `hubs/{hub_uuid}/branding/{file_uuid}.webp` and
returns `logoPath`. A failed database publication attempts to remove the new
object. `DELETE` on the upload endpoint clears the current logo pointer.
Replacement/removal does not synchronously delete old objects; they remain
private and need eventual garbage collection. A failed cleanup can also leave a
private orphan. Do not expose the storage root through a static server or bucket
listing to compensate.

`GET /assets/hubs/{hub_uuid}/branding/{file_uuid}.webp` is deliberately public hub
branding. A narrow database function verifies the exact current logo pointer
before reading storage. Unknown, replaced, removed or unpublished keys return
404. Responses use WebP, `nosniff`, `no-store` and same-origin resource policy.
An already-started response may finish during replacement. This endpoint is not
an adapter for protected lessons, company assets or paid media.

Migration 011 uses a non-login, non-superuser, non-bypass branding reader with
SELECT on hub profiles and no mutation authority. Runtime roles cannot assume
it; its security-definer function returns only a boolean for an exact key.
Bootstrap `plinth_branding_reader NOLOGIN NOSUPERUSER NOBYPASSRLS` before applying
011 after 010 on an existing database. Fresh Compose and CI bootstrap it.

For staging, supply the same private adapter contract: `put(hubId, id, Buffer)`
(create-only), `read(hubId, id)` (Buffer or null), and `delete(hubId, id)`.
A shared private object-storage adapter, deployment credentials/policies, upload
rate limits, disk capacity, garbage collection and real browser/TLS UAT still need
deployment work. Private S3 remains the staging design; no S3 resources have been
provisioned by this slice. Do not enable production credentials before the
applicable Phase 0 gates pass.
