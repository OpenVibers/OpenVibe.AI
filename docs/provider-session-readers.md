# Provider session readers

AI accepts a session cookie only for the fixed read-only readers below. The API does not accept a URL, HTTP method, host, path, or header name from a caller. Requests use the outbound guarded fetch, HTTPS, exact host checks, a response timeout, and refused redirects.

| Provider | Request | Authentication | Data |
| --- | --- | --- | --- |
| Anthropic | `GET https://console.anthropic.com/api/organizations/{org_id}/prepaid/credits` | `Cookie: sessionKey=…` | Purchased balance |
| Anthropic | `GET https://console.anthropic.com/api/organizations/{org_id}/current_spend` | `Cookie: sessionKey=…` | Current spend |
| OpenAI | `GET https://api.openai.com/dashboard/billing/credit_grants` | `Authorization: Bearer sess-…` | Grant totals and grant rows |

The Anthropic organization ID is a non-secret setting stored with the credential. There is no Anthropic promotional-grant reader configured. A 401 or 403 marks the session expired and returns the estimated balance instead. Credentials are AES-GCM encrypted; API responses contain metadata only.

Session-cookie access is powerful: a valid cookie can do anything its browser session can do on that provider site. OpenVibe sends it only to the allowlisted GET readers above. Signing out at the provider ends the session.
